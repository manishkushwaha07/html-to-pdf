const os = require("os");
const cluster = require("cluster");
const express = require("express");
const logger = require("./logger");
const bodyParser = require("body-parser");
const compression = require("compression");
const { chromium } = require("playwright");

// ---------------- CONFIG ---------------- //
const PORT = process.env.PORT || 5000;
const CORES = os.availableParallelism();

// Throughput tuning
const WORKERS = CORES * 2;
const PAGES_PER_WORKER = 2;

// Backpressure
const MAX_QUEUE = 1000;

// ---------------- CLUSTER ---------------- //
if (cluster.isPrimary) {
  console.log(`Primary PID ${process.pid} running`);

  for (let i = 0; i < CORES; i++) {
    cluster.fork();
  }

  cluster.on("exit", (worker) => {
    console.log(`Worker ${worker.process.pid} died. Restarting...`);
    cluster.fork();
  });

  return;
}

// ---------------- WORKER PROCESS ---------------- //
let browser;
let workers = [];
let queue = [];

// ---------------- PAGE CONFIG ---------------- //
async function configurePage(page) {
  if (page._configured) return;

  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (["font", "stylesheet", "media", "xhr", "fetch"].includes(type)) {
      return route.abort();
    }
    route.continue();
  });

  page.setDefaultNavigationTimeout(10000);
  page._configured = true;
}

// ---------------- RENDER ---------------- //
const PDF_OPTIONS =  {
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

async function renderWithPage(page, html, type = "pdf") {
  try {
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 10000 });
    
    if (type === "pdf") {
      await page.emulateMedia({ media: "screen" });
      return await page.pdf(PDF_OPTIONS);
    } 
    return await page.screenshot({ type: 'png'});
  } finally {
    await page.evaluate(() => document.body.innerHTML = "");
    // await page.goto("about:blank");
  }
}

// ---------------- WORKER CLASS ---------------- //
class RenderWorker {
  constructor(browser) {
    this.browser = browser;
    this.pages = [];
    this.running = 0;
  }

  async init() {
    this.context = await this.browser.newContext({
      javaScriptEnabled: false, 
      bypassCSP: true,
    });

    for (let i = 0; i < PAGES_PER_WORKER; i++) {
      const page = await this.context.newPage();
      await configurePage(page);
      this.pages.push(page);
    }
  }

  hasCapacity() {
    return this.pages.length > 0;
  }

  async run(job, type = 'pdf') {
    const page = this.pages.pop();
    this.running++;

    try {
      const result = await renderWithPage(page, job.html, type);
      job.resolve(result);
    } catch (err) {
      job.reject(err);
    } finally {
      this.running--;
      this.pages.push(page);
    }
  }
}

// ---------------- DISPATCH LOOP ---------------- //
function startDispatcher() {
  setInterval(() => {
    if (!queue.length) return;

    for (const worker of workers) {
      if (!queue.length) break;

      if (worker.hasCapacity()) {
        const job = queue.shift();
        worker.run(job);
      }
    }
  }, 1); // ultra-fast loop
}

// ---------------- SERVER ---------------- //
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

const app = express();
app.use(compression());
app.use(express.json({ limit: "10mb" }));
app.use(express.text({ limit: "10mb", type: ["text/*", "application/html"] }));
app.use(bodyParser.text({ limit: "10mb", type: ["application/xml", "text/xml"] }));
  
// -------- HEALTH -------- //
app.get("/health", (req, res) => {
  res.send({
    queue: queue.length,
    workers: workers.length,
    pid: process.pid,
  });
});

// -------- RENDER -------- //
app.post("/playwright", async (req, res) => {
  const html = req.body;
  const type = req.query.type || "pdf";

  if (!html) return res.status(400).send("HTML required");
  if (html.length > 5_000_000) return res.status(413).send("Too large");
  if (html.includes("<script")) return res.status(400).send("Scripts not allowed");

  // Backpressure
  if (queue.length > MAX_QUEUE) {
    return res.status(503).send("Server busy");
  }

  try {
    const result = await new Promise((resolve, reject) => {
      queue.push({ html, resolve, reject });
    });

    res.set( "Content-Type", type === "image" ? "image/png" : "application/pdf");
    res.set({ 
      "Content-Length": result.length, 
      "Content-Disposition": `attachment; filename=playwright.${type === "image" ? "png" : "pdf"}`
    });
    res.end(result);
  } catch (err) {
    res.status(500).send(err.toString());
  }
});


let server;
async function start() {
  await startBrowser();

  // Create workers
  for (let i = 0; i < WORKERS; i++) {
    const worker = new RenderWorker(browser);
    await worker.init();
    workers.push(worker);
  }

  startDispatcher();

  server = app.listen(PORT, () => {
    logger.success(`Server running on port ${PORT}, PID ${process.pid}`);
    if(process.send) {
      process.send('ready');
    }
  });
}

// ---------------- SHUTDOWN ---------------- //
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  console.log(`Worker ${process.pid} shutting down...`);
  if (browser) await browser.close();
  process.exit(0);
}

// ---------------- START ---------------- //
start().catch((err) => {
  console.error(err);
  process.exit(1);
});