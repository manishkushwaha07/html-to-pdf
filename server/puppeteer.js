const fs = require('fs');
const path = require('path');
const multer = require("multer");
const express = require('express');
const puppeteer = require("puppeteer");
const bodyParser = require('body-parser');
const logger = require("./logger");

// ============ REQUEST LOGGER (Lightweight) ============ //
const reqInfo = (req, res, next) => {
  const start = Date.now();
  const bodyPreview = req.body ? JSON.stringify(req.body).slice(0, 100) : "N/A";
  res.on("finish", () => {
    const duration = Date.now() - start;
    logger.info(`IP: ${req.ip} | Method: ${req.method} | Status: ${res.statusCode} | Response Time: ${duration}ms`);
  });
  next();
};

// ============ EXPRESS APP ============ //
const app = express();
app.use(express.json({ limit: "10mb" }));                                           // JSON parser
app.use(express.text({ limit: "10mb", type: ["text/*", "application/html"] }));     // Raw HTML / text parser
app.use(bodyParser.text({ limit: "10mb", type: ["application/xml", "text/xml"] })); // parse XML into raw string first
app.use(reqInfo);
const upload = multer({ dest: "uploads/" });            // temporary folder

let server;
let browser;
const PORT = process.env.PORT || 5000;

async function browserLaunch() {
  try{
    browser = await puppeteer.launch({
      headless: true,
      channel: undefined,                // "chrome" | "chrome-beta" | "chrome-canary"
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-web-security"
      ],
      product: "chrome",                 // chrome | firefox (legacy)
      browser: "chrome",                 // new API in latest puppeteer
    });
    logger.info("browser started");
  }catch (err) {
    logger.error("Connection failed: playwrightBrowserLaunch", err);
  }
}

async function generatePDF(html) {
	if(!browser){
		throw new Error("Browser not initialized");
	}
  let page;
  logger.info('file gnerate start');
  try{ 
    page = await browser.newPage();
    //await page.setContent(html, { waitUntil: "networkidle0" }); //slow
    await page.setContent(html, { waitUntil: "domcontentloaded" }); //faster
    await page.emulateMediaType("print");
    
    const pdf = await page.pdf({
      // path: 'puppeteer.pdf',	 
      scale: 1,
      //format: "A4",
      width: '210mm',
      height: '297mm',
      margin: {
        top: "0",
        bottom: "0",
        left: "0mm",
        right: "0mm"
      },
      landscape: false,
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: ``,
      footerTemplate: ``
    });
    return pdf;
  }catch(error){ 
    logger.error("PDF generation failed:", error);
    throw error; 
  }finally{
    if(page){ await page.close(); };
  }
}

app.post("/puppeteer-upload", upload.single("html"), async (req, res) => {
  logger.info("using puppeteer");
  if (!req.file) return res.status(400).send("No HTML file uploaded");

  try {
    // const html = req.file.buffer.toString(); // as html string;
    const html = fs.readFileSync(req.file.path, "utf8");
	  const pdf = await generatePDF(html);
    fs.unlinkSync(req.file.path); // remove temp file
    res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="puppeteer.pdf"`,
        "Content-Length": pdf.length
      });
      res.send(pdf);
    logger.success(`upload file generated`);
  } catch (err) {
    logger.error(err);
    res.status(500).send("PDF generation failed");
  }
});

app.post("/puppeteer", async (req, res) => {
  const html = req.body;
  if(!html || typeof html !== "string"){
    return res.status(400).send("HTML content is required");
  }
  try {
	  const pdf = await generatePDF(html);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Length": pdf.length,
      "Content-Disposition": `attachment; filename="puppeteer.pdf"`,
    });
    res.send(pdf);
    logger.success(`file generated`);
  } catch (error) {
    res.status(500).send(error.toString());
  }
});

// Start Puppeteer browser once and server
async function startServer() {
  try {
    await browserLaunch();
    
    server = app.listen(PORT, () => {
      logger.success(`Node Proxy Server running on port ${PORT}, PID ${process.pid}`);
      if(process.send) {
        process.send('ready');
      }
    });
  } catch (err) {
    logger.error("Connection failed: startServer", err);
    process.exit(1);
  }
};

startServer();

const stopServer = async () => {
  logger.warn("Shutting down...");
  try{
    await browser.close();
  } catch (error) {
    logger.error("Startup error:", err);
  }
  server.close(() => {
    logger.success("Server gracefully stopped");
    process.exit(0);
  });
};

process.on('SIGINT', stopServer);
process.on('SIGTERM', stopServer);
process.on('message', msg => msg === 'shutdown' && stopServer());