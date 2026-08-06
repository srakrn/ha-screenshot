import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CaptureService, createApp } from "../src/service.js";

const task = { id: "test", width: 800, height: 480, refreshIntervalSeconds: 0, outputPath: "/tmp/not-created-ha-screenshot.png", outputFilename: "test.png", format: "png" };
const silentLogger = { info() {}, error() {} };

test("coalesces concurrent refreshes for the same task", async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const capture = { async capture(value) { calls += 1; assert.equal(value, task); await pending; return { capturedAt: new Date("2026-08-03T00:00:00Z") }; } };
  const service = new CaptureService(capture, task, silentLogger);
  const first = service.refresh(); const second = service.refresh();
  assert.equal(first, second); assert.equal(calls, 1); release(); await first;
  assert.equal(service.lastCaptureAt.toISOString(), "2026-08-03T00:00:00.000Z"); assert.equal(service.lastError, null);
});

test("different tasks capture independently and failures remain scheduler state", async () => {
  const captured = [];
  const capture = { async capture(value) { captured.push(value.id); return { capturedAt: new Date() }; } };
  const first = new CaptureService(capture, { ...task, id: "first" }, silentLogger);
  const second = new CaptureService(capture, { ...task, id: "second" }, silentLogger);
  await Promise.all([first.refresh(), second.refresh()]);
  assert.deepEqual(captured.sort(), ["first", "second"]);
  const failed = new CaptureService({ async capture() { throw new Error("HA unavailable"); } }, task, silentLogger);
  await failed.refresh(); assert.equal(failed.lastError.message, "HA unavailable");
});

async function httpFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ha-screenshot-http-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const morningTask = { ...task, id: "morning", outputPath: path.join(directory, "morning.png"), outputFilename: "morning.png" };
  const fallbackTask = { ...task, id: "fallback", outputPath: path.join(directory, "fallback.png"), outputFilename: "fallback.png" };
  await fs.writeFile(morningTask.outputPath, "morning-image");
  await fs.writeFile(fallbackTask.outputPath, "fallback-image");
  const services = [new CaptureService({}, morningTask, silentLogger), new CaptureService({}, fallbackTask, silentLogger)];
  const image = { id: "display", fallbackTaskId: "fallback", slots: [{ days: ["mon"], start: "06:00", end: "09:00", taskId: "morning" }] };
  const manager = {
    services,
    getService(id) { return services.find((service) => service.task.id === id); },
    getImage(id) { return id === image.id ? image : undefined; },
    resolveImage() { return services[0]; },
    configuration() { return { settings: { haUrl: "http://homeassistant.local:8123", accessToken: "secret", imageScheduleTimezone: "UTC", configUsername: "admin", configPassword: "editor-secret" }, tasks: services.map((service) => service.task), images: [image] }; },
    async replace(value) { return value; },
    refresh(id) { return this.getService(id) ? Promise.resolve() : null; },
  };
  const config = { configured: true, configUsername: "admin", configPassword: "editor-secret", imageScheduleTimezone: "UTC", images: [image] };
  const server = createApp(manager, config, { now: () => new Date("2026-08-03T07:00:00Z") }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, morningTask };
}

test("serves direct and scheduled images without legacy aliases", async (t) => {
  const { base } = await httpFixture(t);
  const direct = await fetch(`${base}/screenshots/morning`);
  assert.equal(direct.status, 200); assert.match(direct.headers.get("cache-control"), /no-store/); assert.equal(await direct.text(), "morning-image");
  const scheduled = await fetch(`${base}/images/display`);
  assert.equal(scheduled.status, 200); assert.equal(await scheduled.text(), "morning-image");
  assert.equal((await fetch(`${base}/screenshots/morning.png`)).status, 404);
  assert.equal((await fetch(`${base}/snapshot`)).status, 404);
  assert.equal((await fetch(`${base}/api/screenshots`)).status, 404);
  assert.equal((await fetch(`${base}/images/missing`)).status, 404);
});

test("returns public gallery and health metadata", async (t) => {
  const { base } = await httpFixture(t);
  const pageResponse = await fetch(`${base}/`); const page = await pageResponse.text();
  assert.match(pageResponse.headers.get("content-security-policy"), /https:\/\/cdn\.jsdelivr\.net/);
  assert.match(page, /bootstrap@5\.3\.8/); assert.match(page, /integrity="sha384-/);
  const galleryResponse = await fetch(`${base}/api/gallery`); const gallery = await galleryResponse.json();
  assert.equal(galleryResponse.status, 200); assert.equal(gallery.images[0].activeTaskId, "morning"); assert.equal(gallery.tasks[0].imageUrl, "/screenshots/morning");
  const healthResponse = await fetch(`${base}/healthz`); const health = await healthResponse.json();
  assert.equal(healthResponse.status, 200); assert.equal(health.images[0].activeTaskId, "morning");
});

test("protects configuration reads and mutations", async (t) => {
  const { base } = await httpFixture(t);
  assert.equal((await fetch(`${base}/api/config`)).status, 401);
  const authorization = `Basic ${Buffer.from("admin:editor-secret").toString("base64")}`;
  const configResponse = await fetch(`${base}/api/config`, { headers: { authorization } });
  const configBody = await configResponse.json();
  assert.equal(configResponse.status, 200);
  assert.equal(configBody.settings.accessTokenConfigured, true);
  assert.equal(configBody.settings.configPasswordConfigured, true);
  assert.equal("accessToken" in configBody.settings, false);
  assert.equal("configPassword" in configBody.settings, false);
  assert.equal((await fetch(`${base}/api/config`, { method: "PUT", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ tasks: [], images: [] }) })).status, 403);
  assert.equal((await fetch(`${base}/api/tasks/morning/capture`, { method: "POST", headers: { authorization } })).status, 403);
  assert.equal((await fetch(`${base}/api/tasks/morning/capture`, { method: "POST", headers: { authorization, "x-requested-with": "ha-screenshot" } })).status, 202);
});

test("allows first-run setup without editor credentials", async (t) => {
  const manager = {
    services: [],
    configuration() {
      return {
        settings: { haUrl: "", accessToken: "", imageScheduleTimezone: "UTC", configUsername: "admin", configPassword: "" },
        tasks: [],
        images: [],
      };
    },
  };
  const config = { configured: false, imageScheduleTimezone: "UTC", images: [] };
  const server = createApp(manager, config).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const admin = await fetch(`${base}/admin/`);
  const api = await fetch(`${base}/api/config`);
  const gallery = await (await fetch(`${base}/api/gallery`)).json();
  assert.equal(admin.status, 200);
  assert.equal(api.status, 200);
  assert.equal((await api.json()).setupRequired, true);
  assert.equal(gallery.setupRequired, true);
});

test("returns 503 without replacing or exposing a missing image", async (t) => {
  const { base, morningTask } = await httpFixture(t);
  await fs.rm(morningTask.outputPath);
  const response = await fetch(`${base}/images/display`); const body = await response.json();
  assert.equal(response.status, 503); assert.equal(body.error, "No screenshot is available yet for task morning");
});
