"use strict";

const os = require("os");
const express = require("express");
const { chromium } = require("playwright");
const PQueue = require("p-queue").default;
const pidusage = require("pidusage");

// ---------------- CONFIG ---------------- //
const PORT = process.env.PORT || 5000;
const CORES = os.availableParallelism() || os.cpus().length;

const CONFIG = {
  pageMemEstimate: 300 * 1024 * 1024,
  maxMemoryRatio: 0.8,
  pagesPerContext: 5,
  monitorInterval: 5000,
};

// ---------------- GLOBALS ---------------- //
let browser;
let queue;

const contexts = new Set();
const contextStats = new Map();

let ctxIdCounter = 0;

// ---------------- UTILS ---------------- //
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---------------- BROWSER ---------------- //
async function startBrowser() {
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}

// ---------------- RESOURCE CALC ---------------- //
function getLimits() {
  const totalMem = os.totalmem();
  const maxMem = totalMem * CONFIG.maxMemoryRatio;

  const maxPagesByMem = Math.floor(maxMem / CONFIG.pageMemEstimate);
  const maxPagesByCPU = CORES * CONFIG.pagesPerContext;

  const maxPages = Math.max(2, Math.min(maxPagesByMem, maxPagesByCPU));
  const maxContexts = Math.max(1, Math.floor(maxPages / CONFIG.pagesPerContext));

  return { maxPages, maxContexts };
}

// ---------------- CONTEXT MANAGEMENT ---------------- //
async function createContext() {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    bypassCSP: true,
  });

  const stats = {
    id: ctxIdCounter++,
    total: 0,
    borrowed: 0,
  };

  contexts.add(context);
  contextStats.set(context, stats);

  return context;
}

async function ensureContexts() {
  const { maxContexts } = getLimits();

  while (contexts.size < maxContexts) {
    await createContext();
  }

  // optional shrink (simple version)
  if (contexts.size > maxContexts) {
    const extra = contexts.size - maxContexts;
    let i = 0;

    for (const ctx of contexts) {
      if (i++ >= extra) break;

      const stats = contextStats.get(ctx);
      if (stats.borrowed === 0) {
        await ctx.close();
        contexts.delete(ctx);
        contextStats.delete(ctx);
      }
    }
  }
}

// ---------------- LOAD BALANCER ---------------- //
function pickBestContext() {
  let best = null;
  let minLoad = Infinity;

  for (const ctx of contexts) {
    const stats = contextStats.get(ctx);

    const load = stats.borrowed / (stats.total || 1);

    if (load < minLoad && stats.total < CONFIG.pagesPerContext) {
      minLoad = load;
      best = ctx;
    }
  }

  return best;
}

// ---------------- PAGE MANAGEMENT ---------------- //
async function acquirePage() {
  let ctx = pickBestContext();

  if (!ctx) {
    await ensureContexts();
    ctx = pickBestContext();
  }

  if (!ctx) throw new Error("No available context");

  const stats = contextStats.get(ctx);

  const page = await ctx.newPage();

  await page.route("**/*", route => {
    const type = route.request().resourceType();
    if (["image", "font", "stylesheet", "media"].includes(type)) {
      return route.abort();
    }
    route.continue();
  });

  stats.total++;
  stats.borrowed++;

  page._context = ctx;

  return page;
}

async function releasePage(page) {
  const ctx = page._context;
  const stats = contextStats.get(ctx);

  try {
    await page.goto("about:blank");
    await page.close();
  } catch {}

  if (stats) {
    stats.borrowed--;
  }
}

async function destroyPage(page) {
  const ctx = page._context;
  const stats = contextStats.get(ctx);

  try {
    await page.close();
  } catch {}

  if (stats) {
    stats.total--;
    stats.borrowed = Math.max(0, stats.borrowed - 1);
  }
}

// ---------------- RENDER ---------------- //
async function render(html) {
  const page = await acquirePage();

  try {
    await page.goto(`data:text/html,${encodeURIComponent(html)}`, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    return await page.pdf({ format: "A4" });

  } catch (err) {
    await destroyPage(page);
    throw err;
  } finally {
    await releasePage(page);
  }
}

// ---------------- QUEUE ---------------- //
function createQueue() {
  const { maxPages } = getLimits();

  queue = new PQueue({
    concurrency: maxPages,
  });
}

// ---------------- MONITOR ---------------- //
function startMonitor() {
  setInterval(async () => {
    const { maxPages, maxContexts } = getLimits();
    const proc = await pidusage(process.pid);

    console.log({
      cpu: proc.cpu.toFixed(2),
      contexts: contexts.size,
      maxContexts,
      queue: queue.size,
    });

    queue.concurrency = maxPages;

    await ensureContexts();

  }, CONFIG.monitorInterval);
}

// ---------------- STATS ---------------- //
function getPagePoolStats() {
  return Array.from(contextStats.values()).map(stats => ({
    context: stats.id,
    total: stats.total,
    available: stats.total - stats.borrowed,
    borrowed: stats.borrowed,
    pending: 0,
  }));
}

// ---------------- EXPRESS ---------------- //
const app = express();
app.use(express.text({ limit: "10mb", type: "*/*" }));

app.get("/health", (req, res) => {
  res.json({
    queue: { waiting: queue.size, running: queue.pending },
    contexts: contexts.size,
    stats: getPagePoolStats(),
  });
});

app.post("/playwright", async (req, res) => {
  try {
    const html = req.body;

    const result = await queue.add(() => render(html));

    res.set("Content-Type", "application/pdf");
    res.end(result);

  } catch (err) {
    res.status(500).send(err.toString());
  }
});

// ---------------- START ---------------- //
async function start() {
  await startBrowser();
  await ensureContexts();
  createQueue();
  startMonitor();

  app.listen(PORT, () => {
    console.log("Server running on", PORT);
  });
}

start();