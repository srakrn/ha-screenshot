import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DashboardCapture, readCustomCss } from "../src/capture.js";

test("composes reusable, file, and task CSS in override order", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ha-screenshot-css-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const customCssFile = path.join(directory, "custom.css");
  await fs.writeFile(customCssFile, "file { order: 3; }");
  const css = await readCustomCss({
    hideCursor: true,
    disableAnimations: false,
    reusableCustomCss: ["base { order: 1; }", "shared { order: 2; }"],
    customCssFile,
    customCss: "task { order: 4; }",
  });
  const positions = ["base", "shared", "file", "task"].map((selector) => css.indexOf(`${selector} {`));
  assert.ok(css.includes("cursor: none"));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test("serializes browser recovery across concurrent failed captures", async () => {
  let launches = 0;
  let firstCloseCalls = 0;
  let secondCloseCalls = 0;
  const firstBrowser = {
    isConnected: () => true,
    on() {},
    async close() { firstCloseCalls += 1; },
    async newContext() { throw new Error("Target page, context or browser has been closed"); },
  };
  const secondBrowser = {
    isConnected: () => true,
    on() {},
    async close() { secondCloseCalls += 1; },
  };
  const capture = new DashboardCapture({ outputDirectory: os.tmpdir() }, { info() {}, error() {} }, {
    launch: async () => (++launches === 1 ? firstBrowser : secondBrowser),
  });
  await capture.start();
  const captureTask = {
    width: 800, height: 480, imageProcessing: { rotation: 0 }, colorScheme: "light", timezone: "UTC",
  };
  const results = await Promise.allSettled([capture.capture(captureTask), capture.capture(captureTask)]);
  assert.deepEqual(results.map((result) => result.reason.category), ["browser_unavailable", "browser_unavailable"]);
  assert.equal(launches, 2);
  assert.equal(firstCloseCalls, 1);
  await Promise.all([capture.stop(), capture.stop()]);
  assert.equal(secondCloseCalls, 1);
});
