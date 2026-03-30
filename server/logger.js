const fs = require('fs');
const path = require('path');

const LOG_TO_FILE = false; // turn ON in production

const logDir = path.resolve("logs");
const logFile = path.join(logDir, "app.log");

// Ensure log directory exists
if (LOG_TO_FILE && !fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

const colors = {
  Reset: "\x1b[0m",
  Bright: "\x1b[1m",
  Red: "\x1b[31m",
  Green: "\x1b[32m",
  Yellow: "\x1b[33m",
  Blue: "\x1b[34m",
};

// Color codes
const COLORS = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  info: "\x1b[36m",     // cyan
  success: "\x1b[32m",  // green
  warn: "\x1b[33m",     // yellow
  error: "\x1b[31m",    // red
  debug: "\x1b[35m"     // magenta
};

// Format timestamp
function getTimestamp() {
  return new Date().toISOString();
}

// Write to file
function writeToFile(message) {
  if (!LOG_TO_FILE) return;
  fs.appendFileSync(logFile, message + "\n");
}

// Core logger
function log(level, color, message, ...args) {
  const timestamp = getTimestamp();
  const formatted = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

  // Console output
  console.log(`${color}${formatted}${COLORS.reset}`, ...args);

  // File output
  writeToFile(formatted);
}

const logger = {
  // info: (msg, ...args) => log("info", COLORS.info, msg, ...args),
  info:    (msg, ...args) => console.log(`${COLORS.info}[INFO]     ${COLORS.reset}${msg}`),
  warn:    (msg, ...args) => console.warn(`${COLORS.warn}[WARN]     ${COLORS.reset}${msg}`),
  error:   (msg, ...args) => console.error(`${COLORS.error}[ERROR]    ${COLORS.reset}${msg}`),
  success: (msg, ...args) => console.log(`${COLORS.success}[SUCCESS] ${COLORS.reset} ${msg}`),
};

module.exports = logger;
// export default logger;