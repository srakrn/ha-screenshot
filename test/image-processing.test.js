import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { captureDimensions, processImage } from "../src/image-processing.js";

function task(overrides = {}) {
  return {
    width: 3,
    height: 2,
    format: "png",
    jpegQuality: 85,
    imageProcessing: {
      mode: "color", levels: 256, palette: [], dither: "none", threshold: 128, invert: false, rotation: 0,
      ...overrides,
    },
  };
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ha-screenshot-processing-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return {
    source: path.join(directory, "source.png"),
    output: path.join(directory, "output.png"),
    retained: path.join(directory, "last-good.png"),
  };
}

async function writeRaw(target, width, height, pixels) {
  await sharp(Buffer.from(pixels), { raw: { width, height, channels: 3 } }).png().toFile(target);
}

test("converts grayscale with fixed luminance and inversion", async (t) => {
  const paths = await fixture(t);
  await writeRaw(paths.source, 3, 2, [
    255, 0, 0, 0, 255, 0, 0, 0, 255,
    0, 0, 0, 255, 255, 255, 128, 128, 128,
  ]);
  await processImage(paths.source, paths.output, task({ mode: "grayscale", invert: true }));
  const { data, info } = await sharp(paths.output).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual({ width: info.width, height: info.height }, { width: 3, height: 2 });
  assert.deepEqual([...data.subarray(0, 9)], [201, 201, 201, 73, 73, 73, 236, 236, 236]);
});

test("produces binary deterministic dithering and threshold boundaries", async (t) => {
  const paths = await fixture(t);
  const input = [80, 100, 120, 140, 160, 180, 100, 120];
  await writeRaw(paths.source, 4, 2, input.flatMap((tone) => [tone, tone, tone]));
  const expected = {
    none: [0, 0, 0, 255, 255, 255, 0, 0],
    "floyd-steinberg": [0, 255, 0, 255, 255, 0, 255, 0],
    atkinson: [0, 0, 255, 255, 255, 255, 0, 0],
  };
  for (const [dither, expectedTones] of Object.entries(expected)) {
    await processImage(paths.source, paths.output, {
      ...task({ mode: "monochrome", dither }), width: 4,
    });
    const data = await sharp(paths.output).removeAlpha().raw().toBuffer();
    assert.deepEqual([...data].filter((_, index) => index % 3 === 0), expectedTones);
  }
});

test("quantizes grayscale to exact nearest four-level tones", async (t) => {
  const paths = await fixture(t);
  const input = [0, 42, 43, 127, 128, 212, 213, 255];
  await writeRaw(paths.source, 8, 1, input.flatMap((tone) => [tone, tone, tone]));
  await processImage(paths.source, paths.output, { ...task({ mode: "grayscale", levels: 4 }), width: 8, height: 1 });
  const data = await sharp(paths.output).removeAlpha().raw().toBuffer();
  assert.deepEqual([...data].filter((_, index) => index % 3 === 0), [0, 0, 85, 85, 170, 170, 255, 255]);
});

test("produces deterministic four-level grayscale dithering", async (t) => {
  const paths = await fixture(t);
  const input = [40, 70, 100, 130, 160, 190, 220, 250];
  await writeRaw(paths.source, 4, 2, input.flatMap((tone) => [tone, tone, tone]));
  const expected = {
    "floyd-steinberg": [0, 85, 85, 170, 170, 170, 255, 255],
    atkinson: [0, 85, 85, 170, 170, 170, 255, 255],
  };
  for (const [dither, expectedTones] of Object.entries(expected)) {
    await processImage(paths.source, paths.output, { ...task({ mode: "grayscale", levels: 4, dither }), width: 4 });
    const data = await sharp(paths.output).removeAlpha().raw().toBuffer();
    assert.deepEqual([...data].filter((_, index) => index % 3 === 0), expectedTones);
  }
});

test("encodes four-level PNG as indexed two-bit data", async (t) => {
  const paths = await fixture(t);
  const input = [0, 85, 170, 255];
  await writeRaw(paths.source, 4, 1, input.flatMap((tone) => [tone, tone, tone]));
  await processImage(paths.source, paths.output, { ...task({ mode: "grayscale", levels: 4 }), width: 4, height: 1 });
  const encoded = await fs.readFile(paths.output);
  assert.equal(encoded[24], 2);
  assert.equal(encoded[25], 3);
  const data = await sharp(encoded).removeAlpha().raw().toBuffer();
  assert.deepEqual([...data].filter((_, index) => index % 3 === 0), input);
});

test("rotates while preserving configured final dimensions and output format", async (t) => {
  const paths = await fixture(t);
  for (const rotation of [0, 90, 180, 270]) {
    const rotatedTask = task({ rotation });
    const sourceSize = [90, 270].includes(rotation) ? { width: 2, height: 3 } : { width: 3, height: 2 };
    assert.deepEqual(captureDimensions(rotatedTask), sourceSize);
    await writeRaw(paths.source, sourceSize.width, sourceSize.height, new Array(18).fill(64));
    await processImage(paths.source, paths.output, rotatedTask);
    const metadata = await sharp(paths.output).metadata();
    assert.deepEqual({ width: metadata.width, height: metadata.height, format: metadata.format }, { width: 3, height: 2, format: "png" });
  }

  const jpegTask = { ...task(), format: "jpeg" };
  await writeRaw(paths.source, 3, 2, new Array(18).fill(192));
  await processImage(paths.source, paths.output, jpegTask);
  assert.equal((await sharp(paths.output).metadata()).format, "jpeg");
});

test("processing failure does not replace a last-good image", async (t) => {
  const paths = await fixture(t);
  await fs.writeFile(paths.source, "not an image");
  await fs.writeFile(paths.retained, "last-good");
  await assert.rejects(processImage(paths.source, paths.output, task()));
  assert.equal(await fs.readFile(paths.retained, "utf8"), "last-good");
  await assert.rejects(fs.access(paths.output));
});
