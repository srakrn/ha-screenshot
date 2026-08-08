import { loadConfig } from "./config.js";
import { DashboardCapture } from "./capture.js";
import { loadRuntimeSettings } from "./runtime.js";
import { createAdminApp, createApp, createPublicApp } from "./service.js";
import { TaskManager } from "./task-manager.js";

const runtime = loadRuntimeSettings();
const config = loadConfig(runtime);
const capture = new DashboardCapture(config);
let captureActive = false;
async function activateCapture() {
  if (captureActive) return;
  await capture.start();
  captureActive = true;
}
const manager = new TaskManager(capture, config, console, { activateCapture });
const servers = [];

if (runtime.runtimeMode === "home_assistant_app") {
  servers.push(createPublicApp(manager, config).listen(config.port, "0.0.0.0"));
  servers.push(createAdminApp(manager, config).listen(config.adminPort, "0.0.0.0"));
  console.info(`Home Assistant App public listener is on port ${config.port}; ingress administration is on port ${config.adminPort}`);
} else {
  servers.push(createApp(manager, config).listen(config.port, "0.0.0.0"));
  console.info(`Standalone listener is on port ${config.port}`);
}

if (config.configured) {
  await activateCapture();
  manager.start();
  console.info(`Started ${manager.services.length} capture task(s) and ${config.images.length} scheduled image feed(s)`);
} else {
  console.info("Waiting for an initial configuration with at least one capture task");
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`Received ${signal}; shutting down`);
  const closingServers = servers.map((server) => new Promise((resolve) => server.close(resolve)));
  await manager.stop();
  if (captureActive) await capture.stop();
  await Promise.all(closingServers);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => void shutdown(signal).then(() => process.exit(0)));
}
