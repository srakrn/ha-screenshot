import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const vendorDirectory = path.join(repositoryRoot, "public/vendor/bootstrap");
const expectedHashes = {
  "LICENSE": "4620c84ad5ce8602ff65640ed6b7c8b78ebb9e036584f0ebc1ccc88206a4bb51",
  "bootstrap.bundle.min.js": "e4fd49181388c48ec5040bd3fe66f57c29c8e67fcd8502b3354b96ec7ab47cc7",
  "bootstrap.min.css": "d85327d99c7a3ee1f9b5d0500d1370acea3ad2db39c163c2f51f232baedbdede",
};

test("vendors only the pinned Bootstrap browser files and license", async () => {
  const files = (await fs.readdir(vendorDirectory)).sort();
  assert.deepEqual(files, Object.keys(expectedHashes).sort());
  for (const file of files) {
    const contents = await fs.readFile(path.join(vendorDirectory, file));
    assert.equal(crypto.createHash("sha256").update(contents).digest("hex"), expectedHashes[file]);
  }

  const packageDefinition = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(packageDefinition.dependencies.bootstrap, undefined);
});

test("HTML pages reference only same-origin frontend assets", async () => {
  for (const filename of ["gallery.html", "index.html"]) {
    const html = await fs.readFile(path.join(repositoryRoot, "public", filename), "utf8");
    const references = [...html.matchAll(/<(?:link|script)\b[^>]*(?:href|src)=["']([^"']+)["']/gi)]
      .map((match) => match[1]);
    assert.ok(references.length > 0);
    assert.equal(references.some((reference) => /^(?:https?:)?\/\//i.test(reference)), false);
    assert.ok(references.some((reference) => reference.includes("vendor/bootstrap/bootstrap.min.css")));
    assert.ok(references.some((reference) => reference.includes("vendor/bootstrap/bootstrap.bundle.min.js")));
  }
});
