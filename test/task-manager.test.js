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

test("rejects first-run settings without a capture task", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ha-screenshot-manager-bootstrap-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = {
    outputDirectory: directory,
    configFile: path.join(directory, "config.json"),
    configured: false,
    haUrl: "",
    accessToken: "",
    imageScheduleTimezone: "UTC",
    configUsername: "admin",
    configPassword: "",
    customCsses: [],
    tasks: [],
    images: [],
  };
  await fs.writeFile(config.configFile, JSON.stringify({ settings: {}, customCsses: [], tasks: [], images: [] }));
  let activated = false;
  const manager = new TaskManager({ async capture() { return { capturedAt: new Date() }; } }, config, silentLogger, {
    activateCapture: async () => { activated = true; },
  });
  await assert.rejects(manager.replace({
    settings: {
      haUrl: "http://homeassistant.local:8123",
      accessToken: "secret",
      imageScheduleTimezone: "Asia/Bangkok",
      configUsername: "operator",
      configPassword: "editor-secret",
    },
    tasks: [],
    images: [],
  }), /At least one screenshot task/);
  assert.deepEqual(manager.services, []);
  assert.equal(config.configured, false);
  assert.equal(activated, false);
  const saved = JSON.parse(await fs.readFile(config.configFile, "utf8"));
  assert.deepEqual(saved.tasks, []);
});

test("activates an App first-run task without persisting Supervisor options", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ha-screenshot-manager-app-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = {
    runtimeMode: "home_assistant_app",
    settingsManagedExternally: true,
    outputDirectory: path.join(directory, "images"),
    configFile: path.join(directory, "config.json"),
    configured: false,
    haUrl: "http://homeassistant:8123",
    accessToken: "supervisor-option-secret",
    imageScheduleTimezone: "UTC",
    configUsername: "ingress",
    configPassword: "managed-by-supervisor",
    customCsses: [], tasks: [], images: [],
  };
  await fs.mkdir(config.outputDirectory);
  let activations = 0;
  const manager = new TaskManager({ async capture() { return { capturedAt: new Date() }; } }, config, silentLogger, {
    activateCapture: async () => { activations += 1; },
  });
  await manager.replace({
    settings: { haUrl: "http://attacker.invalid", accessToken: "replacement" },
    tasks: [{ id: "display", refreshIntervalSeconds: 0 }],
    images: [],
  });
  await manager.stop();
  assert.equal(activations, 1);
  assert.equal(config.configured, true);
  assert.equal(config.haUrl, "http://homeassistant:8123");
  const saved = JSON.parse(await fs.readFile(config.configFile, "utf8"));
  assert.equal("settings" in saved, false);
  assert.doesNotMatch(JSON.stringify(saved), /supervisor-option-secret|replacement/);
  assert.deepEqual(saved.tasks.map((task) => task.id), ["display"]);
});

test("failed validation neither persists nor replaces the running configuration", async (t) => {
  const config = await fixture(t);
  const manager = new TaskManager({}, config, silentLogger);
  const before = await fs.readFile(config.configFile, "utf8");
  await assert.rejects(manager.replace({ tasks: [{ id: "new" }], images: [{ id: "feed", fallbackTaskId: "missing", slots: [] }] }), /fallbackTaskId/);
  assert.equal(await fs.readFile(config.configFile, "utf8"), before);
  assert.equal(manager.services[0].task.id, "old");
});
