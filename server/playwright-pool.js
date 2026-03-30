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
const sanitizeHtml = require("sanitize-html");
const PQueue = require("p-queue").default;

// ------------------- CONFIG ------------------- //
const PORT = process.env.PORT || 5000;
const CORES = os.availableParallelism();

const CONTEXT_POOL_SIZE = Math.max(2, Math.floor(CORES / 2));
const PAGE_POOL_SIZE = Math.max(2, CORES);

// const MAX_CONCURRENCY = Math.floor(CONTEXT_POOL_SIZE * PAGE_POOL_SIZE * 0.8);
const MAX_CONCURRENCY = Math.min(CORES * 2, CONTEXT_POOL_SIZE * 2);
const MAX_QUEUE_SIZE = 500;

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ------------------- BROWSER ------------------- //
let browser;
async function startBrowser() {
  browser = await chromium.launch({
    headless: true,                // run without UI
    // channel: "chromium",           // chrome | chromium | msedge
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-setuid-sandbox",
      "--font-render-hinting=medium",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    ],
  });
  browser.on("disconnected", async () => {
    if(isShuttingDown) { return; }
    logger.error("Browser crashed. Restarting...");
    browser = await startBrowser();
  });
  return browser;
}

// ------------------- CONTEXT POOL ------------------- //
const trackedContexts = new Set();

const contextPoolOpts = {
  min: 2,
  max: CONTEXT_POOL_SIZE,
  maxWaitingClients: 10,
  idleTimeoutMillis: 30000,
  acquireTimeoutMillis: 10000,
  evictionRunIntervalMillis: 10000,
  autostart: true,
}

const contextPool = genericPool.createPool(
  {
    create: async () => {
      const context = await browser.newContext({javaScriptEnabled: false, bypassCSP: true });
      context.pagePool = createPagePool(context);
      trackedContexts.add(context);
      return context;
    },
    destroy: async (context) => {
      await context.pagePool.drain();
      await context.pagePool.clear();
      await context.close().catch(() => {});
      trackedContexts.delete(context);
    },
  },
  contextPoolOpts
);

// ------------------- PAGE POOL ------------------- //
const pagePoolOpts = {
  min: 5,
  max: PAGE_POOL_SIZE,
  maxWaitingClients: 10,
  idleTimeoutMillis: 30000,
  acquireTimeoutMillis: 10000,
  evictionRunIntervalMillis: 10000,
  autostart: true
};

const createPagePool = (context) => genericPool.createPool(
  {
    create: async () => {
      const page = await context.newPage();
      await page.goto('about:blank');
      await configurePage(page);
      await page.waitForLoadState('domcontentloaded', {timeout: 1000} );
      return page;
    },
    destroy: async (page) => {
      await page.close().catch(() => {});
    }
  }, 
  pagePoolOpts
);

// ------------------- CONFIGURE PAGE ------------------- //
async function configurePage(page) {
  if (page._configured) return;

  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (["image", "font", "stylesheet", "media", "xhr", "fetch"].includes(type)) {
      return route.abort();
    }
    route.continue();
  });

  page.setDefaultNavigationTimeout(10000);
  page._configured = true;
}

// ------------------- QUEUE ------------------- //
const queue = new PQueue({ concurrency: MAX_CONCURRENCY, timeout: 10000, throwOnTimeout: true });
queue.on('active', () => {
  // console.log(`PDF Queue active: ${queue.size} waiting, ${queue.pending} running`);
});

async function updateQueueConcurrency() {
  try{
    const { cpu } = await pidusage(process.pid);
    const freeMemRatio = os.freemem() / os.totalmem();
    let next = Math.floor(MAX_CONCURRENCY * (100 - cpu) / 100);

    if (freeMemRatio < 0.2) next -= 2;
    if (freeMemRatio > 0.4) next += 1;
    queue.concurrency = Math.max(2, Math.min(MAX_CONCURRENCY, next));

    logger.info(`[Queue] CPU: ${cpu.toFixed(2)}%, concurrency set to ${queue.concurrency}`);
  } catch(error){
    logger.log(`Queue concurrency adjust error`, error);
  }
}

// ------------------- RENDER PAGE ------------------- //
const pdfOpts = {
  // path: 'invoice.pdf',	 
  scale: 1,
  format: "A4",
  margin: { top: "0", bottom: "0", left: "0", right: "0"},
  landscape: false,
  printBackground: true,
  preferCSSPageSize: false,
  displayHeaderFooter: false,
  headerTemplate: ``,
  footerTemplate: ``,
}

async function render(html, type = "pdf") {
  const context = await contextPool.acquire();
  try {
    const page = await context.pagePool.acquire();
    try {
      // await page.setContent("", { waitUntil: "commit" });
      await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 10000 });
      
      if (type === "pdf") {
        await page.emulateMedia({ media: "screen" });
        return await page.pdf(pdfOpts);
      } 
      return await page.screenshot({ type: 'png'});

    }catch (error) {
      await context.pagePool.destroy(page);
      throw error;
    }finally {
      // await page.evaluate(() => document.body.innerHTML = "");
      if(!page.isClosed()){
        await context.pagePool.release(page).catch(() => {});
      }
    }
  }catch (error) {
    await contextPool.destroy(context);
    throw error;
  }finally {
    await contextPool.release(context).catch(() => {});
  }
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
    await pagePoolWarmUp(context.pagePool);
    logger.info(`context ${index}: page pool ready`);
  }));
  
  // Release contexts back
  await Promise.all(contexts.map(context => contextPool.release(context)));

  logger.info('All pools (context and page) warmed up');
}

async function pagePoolWarmUp(pagePool) {
  pagePool.start();
  // await pagePool.ready().then(() => logger.info(`page pool ready`));

  const pages = await Promise.all( Array.from({ length: pagePool.min }, async() => {
    const page = await context.pagePool.acquire();
    await page.setContent("", { waitUntil: "commit"}); 
    return page;
  }));

  await Promise.all(pages.map(page => context.pagePool.release(page)));
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

// ------------------- REQUEST LOGGER (Lightweight) ------------------- //
const reqInfo = (req, res, next) => {
  const start = Date.now();
  const bodyPreview = req.body ? JSON.stringify(req.body).slice(0, 100) : "N/A";
  res.on("finish", () => {
    const duration = Date.now() - start;
    logger.info(`IP: ${req.ip} | Method: ${req.method} | Status: ${res.statusCode} | Response Time: ${duration}ms`);
    logger.info(`-----------------------------------------------------------------------------------`);
  });
  next();
};

app.use(reqInfo);

// ------------------- Routes ------------------- //
app.get("/health", (req, res) => {
  res.json({
    queue:  { waiting: queue.size, running: queue.pending },
    pool:   { contexts: contextPool.size, available: contextPool.available, pending: contextPool.pending }
  });
});

app.post("/playwright", async (req, res) => {
  try{
    if(queue.size > MAX_QUEUE_SIZE){
      return res.status(503).send("server busy");
    }

    let html = req.body;
    const type = req.query.type || "pdf";

    if (!html) return res.status(400).send("HTML required");
    if (html.length > 5_000_000) return res.status(413).send("HTML too large");
    if (html.includes("<script")) return res.status(400).send("Scripts not allowed");

    html = cleanHTML(html);
    const result = await queue.add(() => render(html, type));
    if (!result) return res.status(500).send("No result");

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

app.post("/playwright-upload", upload.single("html"), async (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");

  try {
    if(queue.size > MAX_QUEUE_SIZE){
      return res.status(503).send("server busy");
    }

    let html = await fs.readFile(req.file.path, "utf8");

    if (!html) return res.status(400).send("HTML required");
    if (html.length > 5_000_000) return res.status(413).send("HTML too large");
    if (html.includes("<script")) return res.status(400).send("Scripts not allowed");
    
    html = cleanHTML(html);
    const result = await queue.add(() => render(html));
    if (!result) return res.status(500).send("No result");
    
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
    if(req.file) {
      await fs.unlink(req.file.path).catch(() => {});
    }
  }
});

// ---------------- SANITIZE ---------------- //
function cleanHTML(html) {
  return html;
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags,
    allowedAttributes: false
  });
}

// ---------------- MONITOR ---------------- //
setInterval(() => {
  updateQueueConcurrency();
  const queueStats = { waiting: queue.size, running: queue.pending };

  const contextStats = {
    total: contextPool.size, available: contextPool.available, borrowed: contextPool.borrowed, pending: contextPool.pending
  };

  const pagePoolStats = [];
  let index = 1;
  for(const context of trackedContexts) {
    const pool = context.pagePool;
    if (!pool) continue;
    pagePoolStats.push({
      context: index++, total: pool.size, available: pool.available, borrowed: pool.borrowed, pending: pool.pending
    });
  }

  logger.log({
    cpu:  getCPUUsage().toFixed(2),
    queue:  queueStats,
    contextPool:  contextStats,
    pagePools: pagePoolStats
  });
}, 5000);

function getCPUUsage() {
  const cpus = os.cpus();
  const cpuUsage = cpus.reduce((acc, cpu) =>{
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    return acc + (1 - cpu.times.idle/total);
  }, 0) / cpus.length * 100;
  return cpuUsage;
}

// ------------------- Start Server ------------------- //
let server;
async function startServer() {
  await startBrowser();
  // await contextPoolWarmUp();
  
  server = app.listen(PORT, () => {
    logger.success(`Server running on port ${PORT}, PID ${process.pid}`);
    if(process.send) {
      process.send('ready');
    }
  });
}

// ------------------- Graceful Shutdown ------------------- //
let isShuttingDown = false;
const stopServer = async () => {
  isShuttingDown = true;
  logger.warn("Shutting down...");
  
  try {
    if (server) await new Promise(r => server.close(r));
    if (browser && browser.isConnected()) { await browser.close(); }
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

startServer().catch(err => {
  logger.error("Failed to start server:", err);
  process.exit(1);
});