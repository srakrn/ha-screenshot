import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { loadConfig, normalizeConfiguration } from "../src/config.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ha-screenshot-config-"));
let sequence = 0;
after(() => fs.rmSync(directory, { recursive: true, force: true }));

function environment(configuration = { tasks: [{ id: "display", dashboardPath: "/lovelace/0" }], images: [] }, overrides = {}) {
  const configFile = path.join(directory, `config-${sequence++}.json`);
  fs.writeFileSync(configFile, JSON.stringify(configuration));
  return {
    HA_URL: "http://homeassistant.local:8123",
    HA_ACCESS_TOKEN: "secret",
    CONFIG_PASSWORD: "editor-secret",
    CONFIG_FILE: configFile,
    ...overrides,
  };
}

test("requires a writable configuration file and editor password", () => {
  assert.throws(() => loadConfig({ HA_URL: "http://homeassistant.local:8123", HA_ACCESS_TOKEN: "secret", CONFIG_PASSWORD: "editor-secret" }), /CONFIG_FILE is required/);
  const env = environment(); delete env.CONFIG_PASSWORD;
  assert.throws(() => loadConfig(env), /CONFIG_PASSWORD/);
  assert.throws(() => loadConfig(environment(undefined, { CONFIG_PASSWORD: "too-short" })), /12 characters/);
});

test("creates and loads an empty bootstrap configuration when the file is missing", () => {
  const configFile = path.join(directory, `missing-${sequence++}.json`);
  const config = loadConfig({
    HA_URL: "http://homeassistant.local:8123",
    HA_ACCESS_TOKEN: "secret",
    CONFIG_PASSWORD: "editor-secret",
    CONFIG_FILE: configFile,
  });

  assert.deepEqual(config.tasks, []);
  assert.deepEqual(config.images, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), { tasks: [], images: [] });

  const reloaded = loadConfig({
    HA_URL: "http://homeassistant.local:8123",
    HA_ACCESS_TOKEN: "secret",
    CONFIG_PASSWORD: "editor-secret",
    CONFIG_FILE: configFile,
  });
  assert.deepEqual(reloaded.tasks, []);
});

test("loads task defaults and global schedule timezone", () => {
  const config = loadConfig(environment(undefined, { IMAGE_SCHEDULE_TIMEZONE: "Asia/Bangkok" }));
  assert.equal(config.tasks.length, 1);
  assert.equal(config.images.length, 0);
  assert.equal(config.tasks[0].dashboardUrl, "http://homeassistant.local:8123/lovelace/0");
  assert.equal(config.tasks[0].width, 800);
  assert.equal(config.tasks[0].height, 480);
  assert.equal(config.tasks[0].outputPath, "/data/display.png");
  assert.equal(config.imageScheduleTimezone, "Asia/Bangkok");
});

test("normalizes scheduled images and overnight ranges", () => {
  const config = loadConfig(environment({
    tasks: [{ id: "day", width: 800, height: 480 }, { id: "night", width: 800, height: 480 }],
    images: [{ id: "display", fallbackTaskId: "day", slots: [{ days: ["FRI", "sat"], start: "22:00", end: "05:00", taskId: "night" }] }],
  }));
  assert.deepEqual(config.images[0], { id: "display", fallbackTaskId: "day", slots: [{ days: ["fri", "sat"], start: "22:00", end: "05:00", taskId: "night" }] });
});

test("rejects malformed roots, task values, duplicate ids, and invalid timezone", () => {
  assert.throws(() => loadConfig(environment([{ id: "legacy" }])), /must contain an object/);
  assert.throws(() => normalizeConfiguration({ tasks: [], images: [] }, {
    haUrl: "http://homeassistant.local:8123",
    outputDirectory: "/data",
  }), /non-empty array/);
  assert.throws(() => loadConfig(environment({ tasks: [{ id: "bad id" }], images: [] })), /id/);
  assert.throws(() => loadConfig(environment({ tasks: [{ id: "same" }, { id: "same" }], images: [] })), /Duplicate screenshot task id/);
  assert.throws(() => loadConfig(environment(undefined, { IMAGE_SCHEDULE_TIMEZONE: "Mars/Olympus" })), /IANA timezone/);
});

test("rejects invalid feed references, time ranges, overlaps, and incompatible tasks", () => {
  const tasks = [{ id: "a", width: 800, height: 480 }, { id: "b", width: 800, height: 480 }, { id: "large", width: 1200, height: 825 }];
  const config = (images) => ({ tasks, images });
  assert.throws(() => loadConfig(environment(config([{ id: "feed", fallbackTaskId: "missing", slots: [] }]))), /fallbackTaskId/);
  assert.throws(() => loadConfig(environment(config([{ id: "feed", fallbackTaskId: "a", slots: [{ days: [], start: "08:00", end: "09:00", taskId: "b" }] }]))), /days/);
  assert.throws(() => loadConfig(environment(config([{ id: "feed", fallbackTaskId: "a", slots: [{ days: ["mon"], start: "8:00", end: "09:00", taskId: "b" }] }]))), /HH:MM/);
  assert.throws(() => loadConfig(environment(config([{ id: "feed", fallbackTaskId: "a", slots: [{ days: ["mon"], start: "08:00", end: "08:00", taskId: "b" }] }]))), /non-zero/);
  assert.throws(() => loadConfig(environment(config([{ id: "feed", fallbackTaskId: "a", slots: [{ days: ["sun"], start: "23:00", end: "02:00", taskId: "b" }, { days: ["mon"], start: "01:00", end: "03:00", taskId: "a" }] }]))), /overlapping/);
  assert.throws(() => loadConfig(environment(config([{ id: "feed", fallbackTaskId: "a", slots: [{ days: ["mon"], start: "08:00", end: "09:00", taskId: "large" }] }]))), /dimensions and format/);
});
