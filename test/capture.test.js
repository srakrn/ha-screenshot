import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readCustomCss } from "../src/capture.js";

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
