
const fs = require('fs');
const path = require('path');
const multer = require("multer");
const express = require('express');
const fetch = require("node-fetch");
const bodyParser = require('body-parser');
const { exec, spawn } = require('child_process');
const logger = require("./logger");

// ============ REQUEST LOGGER (Lightweight) ============ //
const reqInfo = (req, res, next) => {
  logger.info(`${req.method} ${req.originalUrl} | IP: ${req.ip}`);
  next();
};

// ============ EXPRESS APP ============ //
const app = express();
app.use(express.json({ limit: "10mb" }));                                           // JSON parser
app.use(express.text({ limit: "10mb", type: ["text/*", "application/html"] }));     // Raw HTML / text parser
app.use(bodyParser.text({ limit: "10mb", type: ["application/xml", "text/xml"] })); // parse XML into raw string first
const upload = multer({ dest: "uploads/" });            // temporary folder

let server;
const PORT = process.env.PORT || 5000;

app.post("/weasyprint-upload", upload.single("html"), (req, res) => {
  logger.info("using weasyprint");
  const inputFile = req.file.path;
	
  const process = spawn(WEASYPRINT, [
    inputFile,
    "-"                // send PDF to stdout
  ]);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=weasyprint.pdf");

  process.stdout.pipe(res); // <-- binary stream (Blob)

  process.stderr.on("data", err => {
    logger.error(err.toString());
  });

  process.on("close", () => {
    fs.unlinkSync(inputFile);
  });

});

app.post("/vivliostyle-upload", upload.single("html"), async (req, res) => {
  logger.info("using vivliostyle");
  if (!req.file) return res.status(400).send("No HTML file uploaded");

  try {
    const inputPath1 = path.resolve(req.file.path);
    const outputPath = path.resolve("output.pdf");
	const oldPath = path.join(__dirname, "uploads", req.file.filename);
    const inputPath = path.join(__dirname, "uploads", `${req.file.filename}.html`);
	// rename safely
	fs.renameSync(oldPath, inputPath);
	logger.info(inputPath1, inputPath, outputPath);
	
	if (!fs.existsSync(inputPath)) {
		return res.status(500).send("Renamed HTML file not found");
	}
	// Command to generate PDF with Vivliostyle CLI
    const cmd = `npx vivliostyle build ${inputPath} --output ${outputPath}`;

    exec(cmd, (error, stdout, stderr) => {
        // Delete temp HTML file
        if (error) {
            logger.error("Vivliostyle error:", stderr, error);
            return res.status(500).send(stderr || error.message);
        }

        const pdf = fs.readFileSync(outputPath);
		
		// Cleanup safely
		if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
		if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
		
        res.set({
            "Content-Type": "application/pdf",
            "Content-Disposition": 'attachment; filename="vivliostyle.pdf"',
            "Content-Length": pdf.length
        });
        res.send(pdf);
		logger.success(`file generated`);
    });
  } catch (err) {
    logger.error(err);
    res.status(500).send("PDF generation failed");
  }
});

app.post("/stirling", async (req, res) => {
  const html = req.body;
  if(!html || typeof html !== "string"){
    return res.status(400).send("HTML content is required");
  }
  try {
      const response = await fetch("http://localhost:9090/convert", { // stirling PDF server URL
          method: "POST",
          headers: { "Content-Type": "text/html" },
          body: html
      });

      const pdfBuffer = await response.arrayBuffer();
      res.set({
          "Content-Type": "application/pdf",
          "Content-Disposition": "attachment; filename=output.pdf",
      });
      res.send(Buffer.from(pdfBuffer));
  } catch (err) {
      logger.error(err);
      res.status(500).send("PDF generation failed");
  }
});

async function startServer() {
  try {
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

// ============ GRACEFUL SHUTDOWN ============ //
const stopServer = async () => {
  logger.warn("Shutting down...");
  server.close(() => {
    logger.success("Server gracefully stopped");
    process.exit(0);
  });
};

process.on('SIGINT', stopServer);
process.on('SIGTERM', stopServer);
process.on('message', msg => msg === 'shutdown' && stopServer());