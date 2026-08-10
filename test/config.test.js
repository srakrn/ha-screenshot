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
  const outputDirectory = path.join(directory, `output-${sequence++}`);
  fs.mkdirSync(outputDirectory);
  const settings = {
    haUrl: "http://homeassistant.local:8123",
    accessToken: "secret",
    configUsername: "admin",
    configPassword: "editor-secret",
    imageScheduleTimezone: "UTC",
  };
  const stored = Array.isArray(configuration) ? configuration : { settings, ...configuration };
  fs.writeFileSync(path.join(outputDirectory, "config.json"), JSON.stringify(stored));
  return {
    OUTPUT_DIRECTORY: outputDirectory,
    ...overrides,
  };
}

test("loads only deployment settings from the environment", () => {
  const config = loadConfig(environment(undefined, { PORT: "4321", IGNORE_HTTPS_ERRORS: "true" }));
  assert.equal(config.port, 4321);
  assert.equal(config.ignoreHttpsErrors, true);
  assert.equal(config.configFile, path.join(config.outputDirectory, "config.json"));
});

test("creates and loads an empty bootstrap configuration when the file is missing", () => {
  const outputDirectory = path.join(directory, `missing-${sequence++}`);
  const config = loadConfig({ OUTPUT_DIRECTORY: outputDirectory });
  const configFile = path.join(outputDirectory, "config.json");

  assert.equal(config.configured, false);
  assert.deepEqual(config.tasks, []);
  assert.deepEqual(config.images, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), { settings: {}, customCsses: [], tasks: [], images: [] });

  const reloaded = loadConfig({ OUTPUT_DIRECTORY: outputDirectory });
  assert.deepEqual(reloaded.tasks, []);
});

test("loads task defaults and global schedule timezone", () => {
  const definition = { tasks: [{ id: "display", dashboardPath: "/lovelace/0" }], images: [] };
  const env = environment(definition);
  const configFile = path.join(env.OUTPUT_DIRECTORY, "config.json");
  const saved = JSON.parse(fs.readFileSync(configFile));
  saved.settings.imageScheduleTimezone = "Asia/Bangkok";
  fs.writeFileSync(configFile, JSON.stringify(saved));
  const config = loadConfig(env);
  assert.equal(config.tasks.length, 1);
  assert.equal(config.images.length, 0);
  assert.equal(config.tasks[0].dashboardUrl, "http://homeassistant.local:8123/lovelace/0");
  assert.equal(config.tasks[0].width, 800);
  assert.equal(config.tasks[0].height, 480);
  assert.equal(config.tasks[0].outputPath, path.join(env.OUTPUT_DIRECTORY, "display.png"));
  assert.equal(config.tasks[0].outputFilename, "display.png");
  assert.equal(config.tasks[0].timezone, "Asia/Bangkok");
  assert.equal(config.imageScheduleTimezone, "Asia/Bangkok");
  assert.deepEqual(config.tasks[0].imageProcessing, {
    mode: "color", palette: [], dither: "none", threshold: 128, invert: false, rotation: 0,
  });
});

test("rejects a configured service without capture tasks", () => {
  assert.throws(() => loadConfig(environment({ tasks: [], images: [] })), /At least one screenshot task/);
});

test("normalizes reusable custom CSS and ordered task references", () => {
  const config = loadConfig(environment({
    customCsses: [
      { id: "base", css: "ha-card { border: 0; }" },
      { id: "eink", css: "* { color: black; }" },
    ],
    tasks: [{
      id: "display", customCssIds: ["base", "eink"], customCss: ".local { display: none; }",
      imageProcessing: { mode: "monochrome", dither: "atkinson", threshold: 140, invert: true, rotation: 90 },
    }],
    images: [],
  }));
  assert.deepEqual(config.customCsses.map((entry) => entry.id), ["base", "eink"]);
  assert.deepEqual(config.tasks[0].customCssIds, ["base", "eink"]);
  assert.deepEqual(config.tasks[0].reusableCustomCss, ["ha-card { border: 0; }", "* { color: black; }"]);
  assert.deepEqual(config.tasks[0].imageProcessing, {
    mode: "monochrome", palette: [], dither: "atkinson", threshold: 140, invert: true, rotation: 90,
  });
});

test("rejects invalid reusable CSS references and image processing", () => {
  const configuration = (task, customCsses = []) => ({ customCsses, tasks: [{ id: "display", ...task }], images: [] });
  assert.throws(() => loadConfig(environment(configuration({ customCssIds: ["missing"] }))), /existing custom CSS/);
  assert.throws(() => loadConfig(environment(configuration({}, [{ id: "same", css: "a" }, { id: "same", css: "b" }]))), /Duplicate custom CSS/);
  assert.throws(() => loadConfig(environment(configuration({ imageProcessing: { mode: "sepia" } }))), /mode/);
  assert.throws(() => loadConfig(environment(configuration({ imageProcessing: { mode: "grayscale", dither: "atkinson" } }))), /requires monochrome/);
  assert.throws(() => loadConfig(environment(configuration({ imageProcessing: { rotation: 45 } }))), /rotation/);
  assert.throws(() => loadConfig(environment(configuration({ imageProcessing: { palette: ["#000000"] } }))), /not supported/);
});

test("defaults and validates bounded capture retry settings", () => {
  const defaults = loadConfig(environment({ tasks: [{ id: "display" }], images: [] })).tasks[0];
  assert.equal(defaults.retryAttempts, 2);
  assert.equal(defaults.retryInitialDelaySeconds, 2);
  assert.equal(defaults.retryMaximumDelaySeconds, 30);

  const configured = loadConfig(environment({ tasks: [{
    id: "display", retryAttempts: 4, retryInitialDelaySeconds: 0, retryMaximumDelaySeconds: 12,
  }], images: [] })).tasks[0];
  assert.equal(configured.retryAttempts, 4);
  assert.equal(configured.retryInitialDelaySeconds, 0);
  assert.equal(configured.retryMaximumDelaySeconds, 12);
  assert.throws(() => loadConfig(environment({ tasks: [{ id: "display", retryAttempts: 11 }], images: [] })), /retryAttempts/);
  assert.throws(() => loadConfig(environment({ tasks: [{ id: "display", retryInitialDelaySeconds: -1 }], images: [] })), /retryInitialDelaySeconds/);
  assert.throws(() => loadConfig(environment({ tasks: [{ id: "display", retryInitialDelaySeconds: 10, retryMaximumDelaySeconds: 9 }], images: [] })), /retryMaximumDelaySeconds/);
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
  const settings = { haUrl: "http://homeassistant.local:8123", accessToken: "secret", configUsername: "admin", configPassword: "editor-secret", imageScheduleTimezone: "UTC" };
  assert.throws(() => normalizeConfiguration({ settings, tasks: {}, images: [] }, {
    outputDirectory: "/data",
  }), /tasks must be an array/);
  assert.throws(() => loadConfig(environment({ tasks: [{ id: "bad id" }], images: [] })), /id/);
  assert.throws(() => loadConfig(environment({ tasks: [{ id: "same" }, { id: "same" }], images: [] })), /Duplicate screenshot task id/);
  settings.imageScheduleTimezone = "Mars/Olympus";
  assert.throws(() => normalizeConfiguration({ settings, tasks: [{ id: "display" }], images: [] }, { outputDirectory: "/data" }), /IANA timezone/);
});

test("rejects incomplete connection and editor settings", () => {
  const valid = { tasks: [{ id: "display" }], images: [] };
  const env = environment(valid);
  const configFile = path.join(env.OUTPUT_DIRECTORY, "config.json");
  const definition = JSON.parse(fs.readFileSync(configFile));
  delete definition.settings.accessToken;
  fs.writeFileSync(configFile, JSON.stringify(definition));
  assert.throws(() => loadConfig(env), /accessToken/);
  definition.settings.accessToken = "secret";
  definition.settings.configPassword = "";
  fs.writeFileSync(configFile, JSON.stringify(definition));
  assert.throws(() => loadConfig(env), /non-empty string/);
  definition.settings.configPassword = "short";
  fs.writeFileSync(configFile, JSON.stringify(definition));
  assert.equal(loadConfig(env).configPassword, "short");
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
