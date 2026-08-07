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
  const settings = { haUrl: "http://homeassistant.local:8123", accessToken: "secret", configUsername: "admin", configPassword: "editor-secret", imageScheduleTimezone: "UTC" };
  const config = { outputDirectory: directory, configFile: path.join(directory, "config.json"), configured: true };
  Object.assign(config, normalizeConfiguration({ settings, tasks: [{ id: "old", refreshIntervalSeconds: 0 }], images: [] }, config));
  await fs.writeFile(config.configFile, JSON.stringify({ settings, tasks: [{ id: "old" }], images: [] }));
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

test("persists reusable CSS and restarts tasks that consume changed CSS", async (t) => {
  const config = await fixture(t);
  const manager = new TaskManager({ async capture() { return { capturedAt: new Date() }; } }, config, silentLogger);
  const originalService = manager.services[0];
  await manager.replace({
    customCsses: [{ id: "eink", css: "ha-card { border: 0; }" }],
    tasks: [{ ...manager.definitions()[0], customCssIds: ["eink"] }],
    images: [],
  });
  await manager.stop();
  assert.notEqual(manager.services[0], originalService);
  assert.deepEqual(manager.services[0].task.reusableCustomCss, ["ha-card { border: 0; }"]);
  const saved = JSON.parse(await fs.readFile(config.configFile, "utf8"));
  assert.deepEqual(saved.customCsses, [{ id: "eink", css: "ha-card { border: 0; }" }]);
  assert.deepEqual(saved.tasks[0].customCssIds, ["eink"]);
  assert.equal("reusableCustomCss" in saved.tasks[0], false);
});

test("persists web settings while preserving omitted secrets", async (t) => {
  const config = await fixture(t);
  const manager = new TaskManager({ async capture() { return { capturedAt: new Date() }; } }, config, silentLogger);
  await manager.replace({
    settings: {
      haUrl: "https://homeassistant.example.test",
      imageScheduleTimezone: "Asia/Bangkok",
      configUsername: "operator",
    },
    tasks: manager.definitions(),
    images: [],
  });
  await manager.stop();
  const saved = JSON.parse(await fs.readFile(config.configFile, "utf8"));
  assert.deepEqual(saved.settings, {
    haUrl: "https://homeassistant.example.test",
    accessToken: "secret",
    imageScheduleTimezone: "Asia/Bangkok",
    configUsername: "operator",
    configPassword: "editor-secret",
  });
  assert.equal(manager.services[0].task.dashboardUrl, "https://homeassistant.example.test/lovelace/0");
});

test("failed validation neither persists nor replaces the running configuration", async (t) => {
  const config = await fixture(t);
  const manager = new TaskManager({}, config, silentLogger);
  const before = await fs.readFile(config.configFile, "utf8");
  await assert.rejects(manager.replace({ tasks: [{ id: "new" }], images: [{ id: "feed", fallbackTaskId: "missing", slots: [] }] }), /fallbackTaskId/);
  assert.equal(await fs.readFile(config.configFile, "utf8"), before);
  assert.equal(manager.services[0].task.id, "old");
});
