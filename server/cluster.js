//cluster.js file to run node in load balancing mode
// WORKER_FILE=server.js node cluster.js //run cluster with server.js as worker file

// Using Command Prompt (cmd.exe)
// set WORKER_FILE=server.js
// node cluster.js

// Using PowerShell
// $env:WORKER_FILE="server.js"
// node cluster.js


"use strict";

const os = require('os');
const path = require('path');
const cluster = require('cluster');
const logger = require("./logger");

const WORKER_FILE = process.env.WORKER_FILE || "pw-pool.js";
logger.info(`Worker: ${WORKER_FILE}`);
if (cluster.isPrimary) {
  logger.info(`Master ${process.pid} is running`);

  const cpuCount = os.cpus().length;
  logger.info(`Forking for ${cpuCount} CPUs`);

  for (let i = 0; i < cpuCount; i++) {
    cluster.fork({ WORKER_FILE }); // pass it to worker env
  }

  cluster.on('exit', (worker, code, signal) => {
    if (code !== 0 && !worker.exitedAfterDisconnect) {
      logger.warn(`Worker ${worker.id} (PID: ${worker.process.pid}) crashed. Starting a new worker...`);
      cluster.fork({ WORKER_FILE }); // Replace the dead worker
    }
  });
} else {
  const workerPath = path.join(__dirname, WORKER_FILE);
  require(workerPath);
}
