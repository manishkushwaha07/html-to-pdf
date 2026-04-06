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
const PQueue = require("p-queue").default;

// ------------------- CONFIG ------------------- //
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const PORT = process.env.PORT || 5000;
const RAM_GB = os.totalmem() / (1024 ** 3);
const CORES = os.availableParallelism() || os.cpus().length;

const CONFIG = {
  queueMaxSize: 5000,
  pageMaxPoolSize: 2,
}

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

function getRAMUsage(){
  const total = os.totalmem();
  const free = os.freemem();
  return ((1 - free / total) * 100).toFixed(2);
}

var lastCPU = getCPUTimes();
function getSystemCPUUsage() {
  const current = getCPUTimes();
  const idleDiff = current.idle - lastCPU.idle;
  const totalDiff = current.total - lastCPU.total;
  lastCPU = current;
  if(totalDiff === 0){ return 0; }
  return (1 - idleDiff / totalDiff) * 100;
}

// ------------------- QUEUE ------------------- //
function getConcurrency() {
  const cpuCount = CORES;
  const perjobMem = 300 * 1024 * 1024; // 300MB
  const freeMem = os.freemem() / (1024 ** 3); // GB
  const memLimit = Math.floor(freeMem / perjobMem);
  const freeMemRatio = os.freemem() / os.totalmem();
  const cpuUsage = getSystemCPUUsage();
  
  let concurrency = Math.min(cpuCount * 2, memLimit);
  if(cpuUsage > 85){ concurrency -= 1; }
  if(cpuUsage < 60){ concurrency += 1; }
  if(freeMemRatio < 0.2){ concurrency -= 1; }
  if(freeMemRatio > 0.4){ concurrency += 1; }
  return Math.max(CORES, concurrency);
}

const queue = new PQueue({ concurrency: getConcurrency(), timeout: 10 *60 * 1000, throwOnTimeout: true });
queue.on('active', () => {
  // logger.log(`Queue active: ${queue.size} waiting, ${queue.pending} running`);
});

function getQueueStats(){
  return { concurrency: queue.concurrency, waiting: queue.size, running: queue.pending };
}

// ------------------- BROWSER ------------------- //
let browser, context;

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
    await initContext();
  }catch(error){
    logger.error("Browser launch failed:", error);
    throw error;
  } 
}

async function restartBrowser(){
  logger.warn("Restarting browser...");
  try{
    await context?.close();
    await browser?.close();
    await startBrowser();
    logger.success("Browser restarted successfully");
  }catch(error){
    logger.error("Browser restart failed:", error);
  }
}

setInterval(restartBrowser, 24 * 60 * 60 * 1000); // Restart browser every day to prevent memory leaks

// ------------------- CONTEXT & PAGE POOL ------------------- //
async function initContext(){
  context = await browser.newContext({javaScriptEnabled: false, bypassCSP: true, colorScheme: "light" });
}

const pagePoolOpts = {
  min: 0,
  max: CORES * 2,
  idleTimeoutMillis: 30000,
  acquireTimeoutMillis: 20000,
  evictionRunIntervalMillis: 10000,
  autostart: true
};

const pagePool = genericPool.createPool(
  {
    create: async () => {
      const page = await context.newPage();
      await page.goto("about:blank");
      await configurePage(page);
      return { context, page };
    },
    destroy: async ({ context, page }) => {
      try { await page.close(); } catch {}
      // try { await context.close(); } catch {}
    }
  },
  pagePoolOpts,
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
  await page.setDefaultNavigationTimeout(10000);
  await page.setDefaultTimeout(20000);
  page._configured = true;
}

setInterval(async () => {
  if(pagePool.borrowed < 1){
    try{ await context.close().catch(() => {}); } catch {}
    await initContext();
    logger.warn(`Context refreshed to prevent memory leaks`);
  }
}, 60 * 1000); // Check every minute if context needs to be refreshed

function getContextPoolStats(){
  const contexts = browser ? browser.contexts() : [];
  const totalPages = contexts.reduce((acc, ctx) => acc + ctx.pages().length, 0);
  const details = contexts.map((ctx, index) => ({ id: index, pages: ctx.pages().length }));
  return { total: contexts.length, totalPages, details };
}

function getPagePoolStats() {
  return { 
    total: pagePool.size, available: pagePool.available, borrowed: pagePool.borrowed, pending: pagePool.pending
  };
}

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
  const resource = await pagePool.acquire();
  const { page } = resource;
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
    await pagePool.destroy(resource);
    throw error;
  }finally {
    if(page && !page.isClosed()) {
      await pagePool.release(resource).catch(() => {});
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
app.post("/playwright", async (req, res) => {
  try{
    let html = req.body;
    if(!html) { return res.status(400).send("HTML required"); }
    if(html.length > 5_000_000){ return res.status(413).send("HTML too large"); }
    if(/<script[\s>]/i.test(html)){ return res.status(400).send("Scripts not allowed"); }

    if(queue.size >= CONFIG.queueMaxSize){
      return res.status(503).send("Server overloaded");
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
    pagePools: getPagePoolStats(),
  });
});

// ---------- Monitor ----------
async function startMonitor(interval = 1000) {
  setInterval(async () => {
    queue.concurrency = getConcurrency();
    const ram = getRAMUsage(); //%
    const cpu = getSystemCPUUsage();
    const mem = process.memoryUsage();
    const proc = await getProcess(process.pid);
    
    logger.log({
      system: { cpu: `${cpu.toFixed(2)}%`, ram: `${ram}%` },
      process: {
        cpu: `${proc.cpu.toFixed(2)}%`, 
        rss: `${(mem.rss / 1024 / 1024).toFixed(2)} MB`,
        heapUsed: `${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`,
      },
      queue: getQueueStats(),
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
    // 4. Close context pool
    if(context){ await context.close().catch(() => {}) ; }
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