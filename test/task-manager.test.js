import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeConfiguration } from "../src/config.js";
import { TaskManager } from "../src/task-manager.js";

const silentLogger = { info() {}, error() {} };

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ha-screenshot-manager-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = { haUrl: "http://homeassistant.local:8123", outputDirectory: directory, configFile: path.join(directory, "config.json"), imageScheduleTimezone: "UTC" };
  Object.assign(config, normalizeConfiguration({ tasks: [{ id: "old", refreshIntervalSeconds: 0 }], images: [] }, config));
  await fs.writeFile(config.configFile, JSON.stringify({ tasks: [{ id: "old" }], images: [] }));
  return config;
}

test("persists and applies replacement task schedules atomically", async (t) => {
  const config = await fixture(t);
  const captures = [];
  const manager = new TaskManager({ async capture(task) { captures.push(task.id); return { capturedAt: new Date() }; } }, config, silentLogger);
  await manager.replace({ tasks: [{ id: "one", width: 640, height: 384, refreshIntervalSeconds: 0 }, { id: "two", width: 640, height: 384, refreshIntervalSeconds: 0 }], images: [{ id: "feed", fallbackTaskId: "one", slots: [] }] });
  await manager.stop();
  assert.deepEqual(manager.services.map((service) => service.task.id), ["one", "two"]);
  assert.deepEqual(captures.sort(), ["one", "two"]);
  const saved = JSON.parse(await fs.readFile(config.configFile, "utf8"));
  assert.equal(saved.images[0].id, "feed");
  assert.deepEqual(saved.tasks.map(({ id, width }) => ({ id, width })), [{ id: "one", width: 640 }, { id: "two", width: 640 }]);
});

test("schedule-only updates preserve capture services and do not restart captures", async (t) => {
  const config = await fixture(t);
  let captures = 0;
  const manager = new TaskManager({ async capture() { captures += 1; return { capturedAt: new Date() }; } }, config, silentLogger);
  const originalService = manager.services[0];
  await manager.replace({ tasks: manager.definitions(), images: [{ id: "feed", fallbackTaskId: "old", slots: [] }] });
  assert.equal(manager.services[0], originalService);
  assert.equal(captures, 0);
  assert.equal(manager.getImage("feed").fallbackTaskId, "old");
});

test("failed validation neither persists nor replaces the running configuration", async (t) => {
  const config = await fixture(t);
  const manager = new TaskManager({}, config, silentLogger);
  const before = await fs.readFile(config.configFile, "utf8");
  await assert.rejects(manager.replace({ tasks: [{ id: "new" }], images: [{ id: "feed", fallbackTaskId: "missing", slots: [] }] }), /fallbackTaskId/);
  assert.equal(await fs.readFile(config.configFile, "utf8"), before);
  assert.equal(manager.services[0].task.id, "old");
});
