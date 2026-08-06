import { loadConfig } from "./config.js";
import { DashboardCapture } from "./capture.js";
import { createApp } from "./service.js";
import { TaskManager } from "./task-manager.js";

const config = loadConfig();
const capture = new DashboardCapture(config);
const manager = new TaskManager(capture, config);

await capture.start();
const server = createApp(manager, config).listen(config.port, "0.0.0.0", () => {
  console.info(`Serving ${manager.services.length} capture task(s) and ${config.images.length} scheduled image feed(s) on port ${config.port}`);
  manager.start();
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`Received ${signal}; shutting down`);
  server.close();
  await manager.stop();
  await capture.stop();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => void shutdown(signal).then(() => process.exit(0)));
}
