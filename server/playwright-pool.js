const os = require("os");
const fs = require("fs/promises");
const multer = require("multer");
const express = require("express");
const logger = require("./logger");
const bodyParser = require("body-parser");
const compression = require("compression");
const { chromium } = require("playwright");
const genericPool = require("generic-pool");
const PQueue = require("p-queue").default;

// ------------------- CONFIG ------------------- //
const PORT = process.env.PORT || 5000;
const CORES = os.availableParallelism();
const PAGE_POOL_SIZE = Math.ceil(CORES * 1.5);
const CONTEXT_POOL_SIZE = Math.floor(CORES / 2);
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
    if(isShuttingDown) {
      logger.info("Browser disconnected during shutdown");
      return;
    }
    logger.error("Browser crashed. Restarting...");
    await startServer();
  });
  return browser;
}

// ------------------- CONTEXT POOL ------------------- //
const trackedContexts = new Set();

const contextPoolOpts = {
  min: 1,
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
  min: 1,
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
      await configurePage(page);
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

// -------------------DEEP WARM UP POOLS ------------------- //

async function deepWarmUpPools(contextMin, pageMin) {
  const contexts = await Promise.all(
    Array.from({ length: contextMin }, () => contextPool.acquire() )
  );
  
  await Promise.all(contexts.map(async (context) => {
    const pages = await Promise.all(Array.from({ length: pageMin }, async() => {
      const page = await context.pagePool.acquire();
      await page.setContent("", { waitUntil: "commit"}); 
      return page;
    }));

    await Promise.all(pages.map(page => context.pagePool.release(page)));
  }));

  await Promise.all(contexts.map(context => contextPool.release(context)));
}

// ------------------- RENDER PAGE ------------------- //
const pdfOpts = {
  // path: 'invoice.pdf',	 
  scale: 1,
  format: "A4",
  margin: {
    top: "0",
    bottom: "0",
    left: "0",
    right: "0"
  },
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
    }finally {
      try{
        // await page.evaluate(() => document.body.innerHTML = "");
        // await page.goto("about:blank");
        await context.pagePool.release(page);
      }catch (error) {
        await context.pagePool.destroy(page);
      }
    }
  }finally {
    try{
      await contextPool.release(context);
    }catch (error) {
      await contextPool.destroy(context);
    }
  }
}

// ------------------- QUEUE ------------------- //
const MAX_CONCURRENCY = Math.floor(CONTEXT_POOL_SIZE * PAGE_POOL_SIZE * 0.8);
const queue = new PQueue({ 
  concurrency: MAX_CONCURRENCY, 
  timeout: 10000,
  throwOnTimeout: true 
});

queue.on('active', () => {
  // console.log(`PDF Queue active: ${queue.size} waiting, ${queue.pending} running`);
});

function updateQueueConcurrency() {
  pidusage(process.pid, (err, stats) => {
    if (err) return console.error(err);

    const cpu = stats.cpu; // CPU usage percentage

    // Scale concurrency: lower CPU → higher concurrency, higher CPU → lower concurrency
    let newConcurrency = Math.floor(MAX_CONCURRENCY * (100 - cpu) / 100);

    // Clamp to min/max
    newConcurrency = Math.max(10, Math.min(MAX_CONCURRENCY, newConcurrency));

    queue.concurrency = newConcurrency;
    logger.info(`[Queue] CPU: ${cpu.toFixed(1)}%, concurrency set to ${newConcurrency}`);
  });
}

function updateQueue(){
  const FREE_MEM = os.freemem() / os.totalmem();
  if(FREE_MEM < 0.2){
    queue.concurrency = MAX_CONCURRENCY -10;
  }
}

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

// ------------------- Express ------------------- //
const app = express();

// ------------------- KEEP-ALIVE / TIMEOUTS ------------------- //
app.set("keepAliveTimeout", 65000);  // Keep TCP connections alive for 65s
app.set("headersTimeout", 66000);    // Max time to wait for headers from client

app.use(compression());
app.use(express.json({ limit: "10mb" }));
app.use(express.text({ limit: "10mb", type: ["text/*", "application/html"] }));
app.use(bodyParser.text({ limit: "10mb", type: ["application/xml", "text/xml"] }));
app.use(reqInfo);
const upload = multer({ dest: "uploads/" });

// ------------------- Routes ------------------- //
app.get("/health", (req, res) => {
  res.send({ poolSize: contextPool.size, available: contextPool.available, pending: contextPool.pending });
});

app.post("/playwright", async (req, res) => {
  try{
    const html = req.body;
    const type = req.query.type || "pdf";

    if (!html) return res.status(400).send("HTML required");
    if (html.length > 5_000_000) return res.status(413).send("HTML too large");
    if (html.includes("<script")) return res.status(400).send("Scripts not allowed");
    
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
    const html = await fs.readFile(req.file.path, "utf8");

    if (!html) return res.status(400).send("HTML required");
    if (html.length > 5_000_000) return res.status(413).send("HTML too large");
    if (html.includes("<script")) return res.status(400).send("Scripts not allowed");
    
    const result = await queue.add(() => render(html));

    if (!result) return res.status(500).send("No result");
    await fs.unlink(req.file.path);

    res.set({ 
      "Content-Type": "application/pdf", 
      "Content-Length": result.length, 
      "Content-Disposition": `attachment; filename="playwright.pdf"` 
    });
    res.end(result);
  } catch (err) {
    logger.error(err);
    res.status(500).send("PDF generation failed");
  }
});

// ------------------- Pool & CPU Status ------------------- //
async function logPoolAndCPUStatus() {
  const cpuUsage = getCPUUsage();
  let message1 = `CPU Usage: ${cpuUsage.toFixed(3)}% | `;
  let message2 = `Queue -> Total Jobs: ${queue.size} | Pending Jobs: ${queue.pending} | Running Jobs ${queue.runningTasks.length} |`;
  let message3 = `ContextPool -> Total: ${contextPool.size} | Active: ${contextPool.borrowed} | Pending: ${contextPool.pending} | Available: ${contextPool.available} |`;
  
  let message4 = ``;
  Array.from(trackedContexts).forEach((context, index) => {
    if (context.pagePool) {
      const pagePool = context.pagePool;
      message4 += `Context #${index + 1} PagePool -> Total: ${pagePool.size} | Active: ${pagePool.borrowed} | Pending: ${pagePool.pending} | Available: ${pagePool.available} \n`;
    }
  });
  
  if (cpuUsage > 90){ 
    logger.error(message1); 
    logger.error(message2); 
    logger.error(message3); 
    logger.error(message4);
  }else if (cpuUsage > 80){ 
    logger.warn(message1); 
    logger.warn(message2); 
    logger.warn(message3); 
    logger.warn(message4);
  }else { 
    logger.info(message1); 
    logger.info(message2); 
    logger.info(message3); 
    logger.info(message4);
  };
}

// ------------------- CPU Monitor ------------------- //
function getCPUUsage() {
  const cpus = os.cpus();
  const cpuUsage = cpus.reduce((acc, cpu) =>{
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    const idle = cpu.times.idle;
    return acc + (1 - idle/total);
  }, 0) / cpus.length * 100;
  return cpuUsage;
}

// Update every 5 seconds
setInterval(async () => {
  // updateQueueConcurrency();
  await logPoolAndCPUStatus();
}, 5000);

// ------------------- Start Server ------------------- //
let server;
async function startServer() {
  await startBrowser();
  // await deepWarmUpPools(contextPoolOpts.min, pagePoolOpts.min);
  
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
    if (browser && browser.isConnected()) {
      await browser.close();
    }
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