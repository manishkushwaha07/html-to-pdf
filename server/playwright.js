// BullMQ → Worker → p-queue → generic-pool → Playwright  //want this flow
//npm install bullmq ioredis p-queue generic-pool playwright express
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

// ---------- CONFIG ----------
const PORT = process.env.PORT || 5000;
const CORES = os.availableParallelism();
const CONTEXT_POOL_SIZE = 4;
const PAGE_POOL_SIZE = 10;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ------------------- Browser ------------------- //
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

// ------------------- Pool ------------------- //
const pool = genericPool.createPool(
  {
    create: async () => {
      const context = await browser.newContext({ javaScriptEnabled: false, bypassCSP: true });
      const resource = { context, pages: [] };
      await addPagesPerContext(resource, PAGE_POOL_SIZE);
      return resource;
    },
    destroy: async (resource) => {
      await resource.context.close().catch(() => {});
    }
  },
  { 
    min: 2,                           // MIN CONTEXT IN THE POOL
    max: Math.ceil(CORES * 1.5),      // MAX CONSURRENT CONTEXTS
    maxWaitingClients: 10,            // LIMIT QUEUE
    idleTimeoutMillis: 30000,         // CLOSE UNUSED CONTEXTS AFTER 30 SECONDS
    acquireTimeoutMillis: 10000,      // WAIT MAX 10 SECONDS WHEN CALLING pool.acquire() IF NO RESOURCCES ARE AVAILABLE
    evictionRunIntervalMillis: 10000, // CHECK IDLE CONTEXTS EVERY 10 SECONDS
  }
);

async function resetPool(){
  try{
    await pool.drain();
    await pool.clear();
  } catch(error) {
    logger.error(error);
  }
  // pool.start();
}

// ------------------- Create pages per context ------------------- //
async function addPagesPerContext(resource, count = 1){
  for (let i = 0; i < count; i++) {
    const page = await resource.context.newPage();
    await configurePage(page);
    resource.pages.push(page);
  }
}

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

async function getPage(resource) {
  while(true) {
    const page = resource.pages.pop();
    if (page) { return page; }
    //wait instead of creating new page
    await wait(5);
  }
}

async function releasePage(resource, page) {
  if (!page.isClosed()) {
    resource.pages.push(page);
  }
}

async function withRetry(fn, retries = 2) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function render(html, type = "pdf") {
  let resource;

  return withRetry(async () => {
    resource = await pool.acquire();
    const page = await getPage(resource);

    try {
      await page.setContent("", { waitUntil: "commit" }); // domcontentloaded | load | commit /* if HTML doesn’t depend on JS → use commit */
      await page.setContent(html, { waitUntil: "commit", timeout: 10000 }); 
      
      if (type === "pdf") {
        await page.emulateMedia({ media: "screen" });
        return await page.pdf({
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
        });
      } 
      return await page.screenshot({ type: 'png'});
    } finally {
      // await page.goto("about:blank");
      await releasePage(resource, page);
      await pool.release(resource);
    }
  });
}

// ------------------- Queue ------------------- //
const queue = new PQueue({ 
  concurrency: CORES, 
  timeout: 10000,
  throwOnTimeout: true 
});

// Log queue activity
// queue.on('active', () => {
//   logger.info(`PDF Queue active: ${queue.size} waiting, ${queue.pending} running`);
// });

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
  res.send({ poolSize: pool.size, available: pool.available, pending: pool.pending });
});

app.post("/playwright", async (req, res) => {
  try{
    const html = req.body;
    const type = req.query.type || "pdf";

    if (!html) {
      return res.status(400).send("HTML required");
    }
    if (html.length > 5_000_000) {
      return res.status(413).send("HTML too large");
    }
    if (html.includes("<script")) {
      return res.status(400).send("Scripts not allowed");
    }

    logPoolAndCPUStatus();
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

// ------------------- Pool & CPU Status ------------------- //
function logPoolAndCPUStatus() {
  const cpuUsage = getCPUUsage();
  let message = `CPU Usage: ${cpuUsage.toFixed(3)}% | Total Jobs in Queue: ${queue.size} | Jobs pending in Queue: ${queue.pending} | Total Context: ${pool.size} | Active Context: ${pool.borrowed} | Pending Context: ${pool.pending} | Available Context: ${pool.available}`;
  
  if (cpuUsage > 90)  logger.error(message);
  else if (cpuUsage > 80) logger.warn(message);
  else logger.info(message);
}
// ------------------- Start Server ------------------- //
let server;
async function startServer() {
  await startBrowser();
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
    await resetPool();

    if (browser && browser.isConnected()) {
      await browser.close();
    }
    logger.success("Server stopped gracefully");
    process.exit(0);
  } catch (err) {
    logger.error("Shutdown error:", err);
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