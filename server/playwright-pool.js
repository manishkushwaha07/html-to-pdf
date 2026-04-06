"use strict";

const os = require("os");
const fs = require("fs/promises");
const multer = require("multer");
const express = require("express");
const logger = require("./logger");
const pidusage = require("pidusage");
const bodyParser = require("body-parser");
const compression = require("compression");
const { chromium } = require("playwright");
const genericPool = require("generic-pool");
const { stat } = require("fs");
const PQueue = require("p-queue").default;

// ------------------- CONFIG ------------------- //
const PORT = process.env.PORT || 5000;
const RAM_GB = os.totalmem() / (1024 ** 3);
const CORES = os.availableParallelism() || os.cpus().length;

const CONFIG = {
  queueMaxSize: 5000,
  queueMinConcurrency: CORES,
  queueMaxConcurrency: CORES * CORES, 
  contextMaxPoolSize: Math.max(2, CORES),
  pageMaxPoolSize: Math.max(2, CORES * 2),
  contextMemEstimate: 350 * 1024 * 1024, // 350MB per context
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ------------------- BROWSER ------------------- //
let browser;
const browserOpts = {
  headless: true,                // run without UI
  // channel: "chromium",           // chrome | chromium | msedge
  args: [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-sync",
    "--disable-translate",
    "--disable-extensions",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-setuid-sandbox",
    "--disable-background-networking",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-features=IsolateOrigins,site-per-process",
    "--blink-settings=imagesEnabled=false",
    "--font-render-hinting=medium",
    "--metrics-recording-only",
    "--no-first-run",
    "--mute-audio",
  ],
};

async function startBrowser() {
  logger.info("Browser launching...");
  try{
    if(browser){ await browser.close().catch((error) => {
      logger.error("Error closing existing browser:", error);
    });}
    
    await launchBrowser();

    browser.on("disconnected", async () => {
      if(isShuttingDown) { return; }
      logger.error("Browser crashed. Restarting...");
      await launchBrowser();
    });

    logger.success("Browser launch successfully");
    return browser;
  }catch(error){
    logger.error("Browser launch failed:", error);
    throw error;
  }
}

async function launchBrowser(){
  try{
    browser = await chromium.launch(browserOpts);
  }catch(error){
    logger.error("Browser launch failed:", error);
    throw error;
  } 
}

// ------------------- CONTEXT & PAGE POOL ------------------- //
const contextStats = new Map();

const contextPoolOpts = {
  min: 1,
  max: CONFIG.contextMaxPoolSize,
  idleTimeoutMillis: 30000,
  acquireTimeoutMillis: 20000,
  evictionRunIntervalMillis: 10000,
  autostart: true,
  testOnBorrow: false,
}

const contextPool = genericPool.createPool(
  {
    create: async () => {
      if(!browser || !browser.isConnected()){
        await launchBrowser();
      }
      const context = await browser.newContext({javaScriptEnabled: false, bypassCSP: true, colorScheme: "light" });
      contextStats.set(context, { total: 0, borrowed: 0 });
      return context;
    },
    destroy: async (context) => {
      await context.close().catch(() => {});
      contextStats.delete(context);
    },
    validate: () => browser && browser.isConnected()
  },
  contextPoolOpts,
);

const pagePoolOpts = {
  min: 1,
  max: CONFIG.pageMaxPoolSize,
  idleTimeoutMillis: 30000,
  acquireTimeoutMillis: 20000,
  evictionRunIntervalMillis: 10000,
  autostart: true
};

const pagePool = genericPool.createPool(
  {
    create: async () => {
      let context;
      for(const ctx of contextStats.keys()){
        const stats = contextStats.get(ctx);
        if(stats.borrowed < CONFIG.pageMaxPoolSize){
          context = ctx;
          break
        } 
      }

      if(!context && contextPool.size < contextPool.max){
        context = await contextPool.acquire();
      }

      if(!context){ 
        await wait(100);
        // return await pagePool.create();
        context = await contextPool.acquire();
      }
      
      try{
        const page = await context.newPage();
        await page.goto('about:blank');
        await configurePage(page);
        // await page.waitForLoadState('domcontentloaded', {timeout: 1000} );
        const stats = contextStats.get(context);
        if(stats) { stats.borrowed++; stats.total++; }
        page._context = context;
        return page;
      }catch(error){
        await contextPool.release(context);
        throw error;
      }
    },
    destroy: async (page) => {
      const context = page._context;
      const stats = contextStats.get(context);
      try { await page.close(); } catch {}
      if(stats){
        stats.total = Math.max(0, stats.total - 1);
        stats.borrowed = Math.max(0, stats.borrowed - 1);
      }
      if(stats.borrowed === 0){
        try { await contextPool.release(context); } catch {}
      }
    },
  }, 
  pagePoolOpts
);

async function configurePage(page) {
  if(page._configured) { return; }

  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if(["image", "font", "stylesheet", "media", "xhr", "fetch"].includes(type)) {
      return route.abort();
    }
    route.continue();
  });

  page.setDefaultNavigationTimeout(10000);
  page._configured = true;
}

// -------------------DEEP WARM UP POOLS ------------------- //
async function contextPoolWarmUp() {
  // Warm context pool
  contextPool.start();
  // await contextPool.ready().then(() => logger.info(`context pool ready`));

  // Acquire all pre-created contexts
  const contexts = await Promise.all(
    Array.from({ length: contextPool.min }, () => contextPool.acquire() )
  );
  logger.info(`contextx size ${contexts.length}`)
  // Warm each page pool
  await Promise.all(contexts.map(async (context, index) => {
    try{
      await pagePoolWarmUp(context);
      logger.info(`context ${index}: page pool ready`);
    }catch(error){
      logger.error(`context ${index}: page pool warm-up error`, error);
    }
  }));
  
  // Release contexts back
  await Promise.all(contexts.map(context => contextPool.release(context)));

  logger.info('All pools (context and page) warmed up');
}

async function pagePoolWarmUp(context = null) {
  pagePool.start();
  // await pagePool.ready().then(() => logger.info(`page pool ready`));

  const pages = await Promise.all( Array.from({ length: pagePool.min }, async() => {
    const page = await pagePool.acquire();
    try{
      await page.setContent("", { waitUntil: "commit"}); // ensure page is fully ready
      return page;
    } catch(error){
      await pagePool.destroy(page);
      throw error;
    }
  }));

  await Promise.all(pages.map(page => {
    const context = page._context;
    const stats = contextStats.get(context);
    if(stats){ stats.borrowed = Math.max(0, stats.borrowed - 1); }
    pagePool.release(page) 
  }));
}

// ------------------- QUEUE ------------------- //
const queue = new PQueue({ concurrency: CONFIG.queueMaxConcurrency, timeout: 20000, throwOnTimeout: true });
queue.on('active', () => {
  // logger.log(`Queue active: ${queue.size} waiting, ${queue.pending} running`);
});

// ------------------- RENDER PAGE ------------------- //
const pdfOpts = {
  // path: 'invoice.pdf',	 
  scale: 1,
  format: "A4",
  margin: { top: "0", bottom: "0", left: "0", right: "0"},
  landscape: false,
  printBackground: false,
  preferCSSPageSize: false,
  displayHeaderFooter: false,
  headerTemplate: ``,
  footerTemplate: ``,
}

async function render(html, type = "pdf") {
  const page = await pagePool.acquire();
  try {
    // await page.goto('about:blank', { waitUntil: 'commit' });
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 20000 });
    // await page.goto(`data:text/html,${encodeURIComponent(html)}`, { waitUntil: "domcontentloaded", timeout: 20000 })
    if(type === "pdf"){
      await page.emulateMedia({ media: "screen" });
      return await page.pdf(pdfOpts);
    } 
    return await page.screenshot({ type: 'png'});
  }catch (error) {
    if(error.name === 'TimeoutError') { /* timeoutCount++ */ }
    if(error.name === 'TargetClosedError'){ }
    if(page){ await pagePool.destroy(page); }
    throw error;
  }finally {
    if(page && !page.isClosed()){
      try { 
        await page.setContent("");
        const context = page._context
        const stats = contextStats.get(context);
        if(stats){ stats.borrowed = Math.max(0, stats.borrowed - 1); }
        await pagePool.release(page);
      } catch {}
    }
  }
}

// ------------------- Express ------------------- //
const app = express();
const upload = multer({ dest: "uploads/" });

// ------------------- KEEP-ALIVE / TIMEOUTS ------------------- //
app.set("keepAliveTimeout", 65000);  // Keep TCP connections alive for 65s
app.set("headersTimeout", 66000);    // Max time to wait for headers from client

app.use(compression());
app.use(express.json({ limit: "10mb" }));
app.use(express.text({ limit: "10mb", type: ["text/*", "application/html"] }));
app.use(bodyParser.text({ limit: "10mb", type: ["application/xml", "text/xml"] }));

// ------------------- ENABLE CORS ------------------- //
const headers = (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if(req.method === "OPTIONS"){ return res.sendStatus(200); }
  next();
}
app.use(headers);

// ------------------- REQUEST LOGGER (Lightweight) ------------------- //
const reqInfo = (req, res, next) => {
  const start = Date.now();
  const bodyPreview = req.body ? JSON.stringify(req.body).slice(0, 100) : "N/A";
  res.on("finish", () => {
    const duration = Date.now() - start;
    logger.info(`IP: ${req.ip} | Method: ${req.method} | Status: ${res.statusCode} | Response Time: ${duration}ms`);
  });
  next();
};
app.use(reqInfo);

// ------------------- Routes ------------------- //
app.post("/playwright-upload", upload.single("html"), async (req, res) => {
  if(!req.file){ return res.status(400).send("No file uploaded"); }

  try {
    let html = await fs.readFile(req.file.path, "utf8");
    if(!html){ return res.status(400).send("HTML required"); }
    if(html.length > 5_000_000){ return res.status(413).send("HTML too large"); }
    if(html.includes("<script")){ return res.status(400).send("Scripts not allowed"); }

    if(queue.size > CONFIG.queueMaxSize){
      return res.status(503).send("Server overloaded");
    }
    const result = await queue.add(() => render(html));
    if(!result){ return res.status(500).send("No result"); }
    
    res.set({ 
      "Content-Type": "application/pdf", 
      "Content-Length": result.length, 
      "Content-Disposition": `attachment; filename="playwright.pdf"` 
    });
    res.end(result);
  } catch (err) {
    logger.error(err);
    res.status(500).send("PDF generation failed");
  } finally {
    if(req.file){ await fs.unlink(req.file.path).catch(() => {}); }
  }
});

app.post("/playwright", async (req, res) => {
  try{
    let html = req.body;
    if(!html) { return res.status(400).send("HTML required"); }
    if(html.length > 5_000_000){ return res.status(413).send("HTML too large"); }
    if(/<script[\s>]/i.test(html)){ return res.status(400).send("Scripts not allowed"); }

    if(queue.size >= CONFIG.queueMaxSize){
      return res.status(503).send("Server overloaded");
    }
    if(queue.size > 1000){
      await queue.onSizeLessThan(CONFIG.queueMaxSize);
    }

    const type = req.query.type || "pdf";
    const result = await queue.add(() => render(html, type));
    if(!result){ return res.status(500).send("No result"); }

    res.set( "Content-Type", type === "image" ? "image/png" : "application/pdf");
    res.set({ 
      "Content-Length": result.length, 
      "Content-Disposition": `attachment; filename=playwright.${type === "image" ? "png" : "pdf"}`
    });
    res.end(result);
  } catch (err) {
    logger.error(err);
    res.status(500).send(err.toString());
  }
});

app.get("/health", (req, res) => {
  res.json({
    cpu:  getSystemCPUUsage(),
    queue:  getQueueStats(),
    contextPool:  getContextPoolStats(),
    pagePools: getPagePoolStats(),
  });
});

async function updateQueueConcurrency() {
  logger.info('updateQueueConcurrency started');
  try{
    const cpu = getSystemCPUUsage();
    const freeMemRatio = os.freemem() / os.totalmem();
    let next = CONFIG.contextMaxPoolSize * CONFIG.pageMaxPoolSize;

    if(cpu > 90){ next -= 1; }
    if(cpu < 70){ next += 1; }
    if(freeMemRatio < 0.2){ next -= 2; }
    if(freeMemRatio > 0.4){ next += 1; }
    queue.concurrency = Math.max(2, Math.min(CONFIG.queueMaxConcurrency, next));

    logger.info(`[Queue] CPU: ${cpu.toFixed(2)}%, concurrency set to ${queue.concurrency}`);
  } catch(error){
    logger.log(`Queue concurrency adjust error`, error);
  }
}

function adjustQueueConcurrency() {
  try{
    const cpu = getSystemCPUUsage();
    const ram = parseFloat(getRAMUsage());
    
    const CPU_LIMIT = 85; // %
    const RAM_LIMIT = 85; // %
    const cpuFactor = Math.max(0, (CPU_LIMIT - cpu) / CPU_LIMIT);
    const ramFactor = Math.max(0, (RAM_LIMIT - ram) / RAM_LIMIT);
    const safeFactor = Math.min(cpuFactor, ramFactor);

    const maxCapacity = contextPool.max * CONFIG.pageMaxPoolSize;
    let next = Math.floor(safeFactor * maxCapacity);
    next = Math.max(CONFIG.queueMinConcurrency, next);
    // if(cpu > 85 || ram > 85) next -= 1;
    // else if(cpu < 60 && ram < 80) next += 1;
    queue.concurrency =Math.min(maxCapacity, next);
    logger.info(`CPU: ${cpu.toFixed(2)} | RAM: ${ram}% | Next concurrency: ${queue.concurrency}`);
  } catch(error){
    logger.log(`Queue concurrency adjust error`, error);
  }
}

// ---------- CPU helpers ----------
async function getProcess(pid){
  return await pidusage(pid);
}

function getCPUTimes(){
  const cpus = os.cpus();
  let idle = 0; let total = 0;
  cpus.forEach(cpu => {
    for (let type in cpu.times) {
      total += cpu.times[type];
    }
    idle += cpu.times.idle;
  });
  return { idle, total };
}

// ---------- RAM helpers ----------
function getRAMUsage(){
  const total = os.totalmem();
  const free = os.freemem();
  return ((1 - free / total) * 100).toFixed(2);
}

// ---------------- MONITOR ---------------- //
let lastCPU = getCPUTimes();
function getSystemCPUUsage() {
  const current = getCPUTimes();
  const idleDiff = current.idle - lastCPU.idle;
  const totalDiff = current.total - lastCPU.total;
  lastCPU = current;
  if(totalDiff === 0){ return 0; }
  return (1 - idleDiff / totalDiff) * 100;
}

function getQueueStats(){
  return { concurrency: queue.concurrency, waiting: queue.size, running: queue.pending };
}

function getContextPoolStats(){
  return {
    total: contextPool.size, available: contextPool.available, borrowed: contextPool.borrowed, pending: contextPool.pending
  };
}

function getPagePoolStats() {
  return { 
    total: pagePool.size, available: pagePool.available, borrowed: pagePool.borrowed, pending: pagePool.pending
  };
}

// ---------- Monitor ----------
async function startMonitor(interval = 1000) {
  setInterval(async () => {
    // adjustQueueConcurrency();
    // updateQueueConcurrency();
    const ram = getRAMUsage(); //%
    const cpu = getSystemCPUUsage();
    const proc = await getProcess(process.pid);
    const mem = process.memoryUsage();
    
    logger.log({
      system: { cpu: `${cpu.toFixed(2)}%`, ram: `${ram}%` },
      process: {
        cpu: `${proc.cpu.toFixed(2)}%`, 
        rss: `${(mem.rss / 1024 / 1024).toFixed(2)} MB`,
        heapUsed: `${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`,
      },
      queue: getQueueStats(),
      contextPool: getContextPoolStats(),
      pagePools: getPagePoolStats()
    });
    logger.info(`-----------------------------------------------------------------------------------`);
  }, interval);
}

// ------------------- Start Server ------------------- //
let server;
async function startServer() {
  logger.info("Starting server...");
  await startBrowser();
  await startMonitor(5000);
  // await contextPoolWarmUp();
  
  server = app.listen(PORT, () => {
    logger.success(`Server running on port ${PORT}, PID ${process.pid}`);
    if(process.send){ process.send('ready'); }
  });
}

// ------------------- Graceful Shutdown ------------------- //
let isShuttingDown = false;
const stopServer = async () => {
  isShuttingDown = true;
  logger.warn("Shutting down...");
  
  try {
    // 1. Stop accepting new requests
    if(server){ await new Promise(r => server.close(r)); }
    // 2. Pause queue and wait for jobs
    queue.pause();
    await queue.onIdle();
    // 3. Drain page pool
    await pagePool.drain(); await pagePool.clear();
    // 4. Drain context pool
    await contextPool.drain(); await contextPool.clear();
    // 5. Close browser LAST
    if(browser && browser.isConnected()){ await browser.close(); }
    logger.success("Server stopped gracefully");
    process.exit(0);
  } catch (err) {
    logger.error(`Shutdown error: ${err.message}`);
    process.exit(1);
  }
};

process.on("SIGINT", stopServer);
process.on("SIGTERM", stopServer);
process.on("message", msg => msg === "shutdown" && stopServer());

startServer().then(() =>{
  logger.success("Server started successfully");
}).catch(err => {
  logger.error("Failed to start server:", err);
  process.exit(1);
});