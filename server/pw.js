const os = require("os");
const fs = require("fs/promises");
const express = require("express");
const multer = require("multer");
const compression = require("compression");
const logger = require("./logger");
const { chromium } = require("playwright");
const PQueue = require("p-queue").default;

const PORT = process.env.PORT || 5000;

// 🔥 Tunables
const CORES = os.availableParallelism();
const CONTEXTS = Math.max(1, Math.floor(CORES / 2));
const PAGES_PER_CONTEXT = 6;

let browser;
let contexts = [];
let pagePool = [];
let isShuttingDown = false;

// ------------------- Browser ------------------- //
async function startBrowser() {
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  browser.on("disconnected", async () => {
    if (isShuttingDown) return;
    logger.error("Browser crashed. Restarting...");
    await init();
  });
}

// ------------------- Page Setup ------------------- //
async function configurePage(page) {
  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (["image", "font", "stylesheet", "media", "xhr", "fetch"].includes(type)) {
      return route.abort();
    }
    route.continue();
  });

  page.setDefaultNavigationTimeout(8000);
}

// ------------------- Init Pool ------------------- //
async function init() {
  await startBrowser();

  contexts = [];
  pagePool = [];

  for (let i = 0; i < CONTEXTS; i++) {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      bypassCSP: true,
    });

    contexts.push(context);

    for (let j = 0; j < PAGES_PER_CONTEXT; j++) {
      const page = await context.newPage();
      await configurePage(page);

      pagePool.push({
        page,
        busy: false,
      });
    }
  }

  logger.success(`Initialized ${contexts.length} contexts & ${pagePool.length} pages`);
}

// ------------------- Page Acquire ------------------- //
async function acquirePage() {
  while (true) {
    const free = pagePool.find(p => !p.busy);
    if (free) {
      free.busy = true;
      return free.page;
    }
    await new Promise(r => setTimeout(r, 5)); // tiny wait
  }
}

function releasePage(page) {
  const item = pagePool.find(p => p.page === page);
  if (item) item.busy = false;
}

// ------------------- Render ------------------- //
async function render(html, type = "pdf") {
  const page = await acquirePage();

  try {
    // 🔥 Soft reset (no navigation)
    await page.setContent("", { waitUntil: "commit" });
    await page.setContent(html, { waitUntil: "commit" });

    if (type === "pdf") {
      return await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "0", bottom: "0", left: "0", right: "0" },
      });
    }

    return await page.screenshot({ type: "png" });

  } finally {
    releasePage(page);
  }
}

// ------------------- Queue ------------------- //
const queue = new PQueue({
  concurrency: CORES,
  timeout: 15000,
  throwOnTimeout: true,
});

// ------------------- Express ------------------- //
const app = express();
app.use(compression());
app.use(express.text({ limit: "10mb", type: ["text/*", "application/html"] }));

const upload = multer({ dest: "uploads/" });

// ------------------- Routes ------------------- //
app.get("/health", (req, res) => {
  const busy = pagePool.filter(p => p.busy).length;
  res.send({
    totalPages: pagePool.length,
    busy,
    free: pagePool.length - busy
  });
});

app.post("/playwright", async (req, res) => {
  try {
    const html = req.body;
    const type = req.query.type === "image" ? "image" : "pdf";

    if (!html) return res.status(400).send("HTML required");
    if (html.length > 5_000_000) return res.status(413).send("Too large");
    if (html.includes("<script")) return res.status(400).send("Scripts not allowed");

    const result = await queue.add(() => render(html, type));

    res.set({
      "Content-Type": type === "image" ? "image/png" : "application/pdf",
      "Content-Length": result.length,
    });

    res.end(result);

  } catch (err) {
    logger.error(err);
    res.status(500).send("Render failed");
  }
});

app.post("/playwright-upload", upload.single("html"), async (req, res) => {
  try {
    const html = await fs.readFile(req.file.path, "utf8");
    const result = await queue.add(() => render(html));

    await fs.unlink(req.file.path);

    res.set({
      "Content-Type": "application/pdf",
      "Content-Length": result.length,
    });

    res.end(result);

  } catch (err) {
    logger.error(err);
    res.status(500).send("Failed");
  }
});

// ------------------- Start ------------------- //
let server;

async function start() {
  await init();

  server = app.listen(PORT, () => {
    logger.success(`Running on ${PORT}`);
  });
}

// ------------------- Shutdown ------------------- //
async function shutdown() {
  isShuttingDown = true;

  try {
    if (server) await new Promise(r => server.close(r));

    for (const ctx of contexts) {
      await ctx.close();
    }

    await browser.close();

    process.exit(0);
  } catch (e) {
    process.exit(1);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start();