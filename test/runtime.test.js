import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { loadRuntimeSettings } from "../src/runtime.js";

test("defaults to standalone runtime and preserves deployment environment settings", () => {
  const runtime = loadRuntimeSettings({ env: { OUTPUT_DIRECTORY: "./data-test", PORT: "4321", IGNORE_HTTPS_ERRORS: "true" } });
  assert.equal(runtime.runtimeMode, "standalone");
  assert.equal(runtime.port, 4321);
  assert.equal(runtime.adminPort, null);
  assert.equal(runtime.ignoreHttpsErrors, true);
  assert.equal(runtime.settingsManagedExternally, false);
});

test("loads validated Home Assistant App options and fixed listener paths", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ha-screenshot-app-runtime-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const optionsFile = path.join(directory, "options.json");
  fs.writeFileSync(optionsFile, JSON.stringify({
    ha_url: "http://homeassistant:8123",
    ha_access_token: "secret",
    image_schedule_timezone: "Asia/Bangkok",
    ignore_https_errors: true,
    public_base_url: "http://homeassistant.local:3000",
    log_level: "info",
  }));
  const runtime = loadRuntimeSettings({ env: { RUNTIME_MODE: "home_assistant_app" }, optionsFile, dataDirectory: directory });
  assert.equal(runtime.outputDirectory, path.join(directory, "images"));
  assert.equal(runtime.configFile, path.join(directory, "config.json"));
  assert.equal(runtime.port, 3000);
  assert.equal(runtime.adminPort, 8099);
  assert.equal(runtime.haUrl, "http://homeassistant:8123");
  assert.equal(runtime.imageScheduleTimezone, "Asia/Bangkok");
  const config = loadConfig(runtime);
  assert.equal(config.configured, false);
  assert.equal(config.accessToken, "secret");
  assert.equal(fs.existsSync(runtime.configFile), false);

  fs.writeFileSync(runtime.configFile, JSON.stringify({ customCsses: [], tasks: [], images: [] }));
  const idleConfig = loadConfig(runtime);
  assert.equal(idleConfig.configured, true);
  assert.deepEqual(idleConfig.tasks, []);
});

test("rejects invalid runtime mode and redacts no option values into errors", (t) => {
  assert.throws(() => loadRuntimeSettings({ env: { RUNTIME_MODE: "automatic" } }), /standalone or home_assistant_app/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ha-screenshot-app-options-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const optionsFile = path.join(directory, "options.json");
  fs.writeFileSync(optionsFile, JSON.stringify({ ha_url: "not-a-url", ha_access_token: "do-not-leak-this", image_schedule_timezone: "UTC" }));
  assert.throws(
    () => loadRuntimeSettings({ env: { RUNTIME_MODE: "home_assistant_app" }, optionsFile, dataDirectory: directory }),
    (error) => /ha_url/.test(error.message) && !/do-not-leak-this/.test(error.message),
  );
});
