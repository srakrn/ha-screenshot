import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { CaptureService, createAdminApp, createApp, createPublicApp } from "../src/service.js";
import { CaptureError, FAILURE_CATEGORIES } from "../src/capture.js";

const task = { id: "test", width: 800, height: 480, refreshIntervalSeconds: 0, outputPath: "/tmp/not-created-ha-screenshot.png", outputFilename: "test.png", format: "png" };
const silentLogger = { info() {}, error() {} };

async function png(width = 800, height = 480, color = "white") {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

test("coalesces concurrent refreshes for the same task", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ha-screenshot-capture-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const captureTask = { ...task, outputPath: path.join(directory, "test.png") };
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const capture = { async capture(value) { calls += 1; assert.equal(value, captureTask); await pending; await fs.writeFile(value.outputPath, await png()); return { capturedAt: new Date("2026-08-03T00:00:00Z") }; } };
  const service = new CaptureService(capture, captureTask, silentLogger);
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
  await failed.refresh(); assert.equal(failed.lastError.category, "navigation");
});

test("retries transient failures, coalesces the sequence, and records attempts", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ha-screenshot-retry-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const captureTask = {
    ...task, outputPath: path.join(directory, "retry.png"), retryAttempts: 2,
    retryInitialDelaySeconds: 0, retryMaximumDelaySeconds: 0,
  };
  let calls = 0;
  const capture = { async capture(value) {
    calls += 1;
    if (calls === 1) throw new CaptureError(FAILURE_CATEGORIES.NAVIGATION);
    await fs.writeFile(value.outputPath, await png());
    return { capturedAt: new Date("2026-08-03T00:00:00Z") };
  } };
  const service = new CaptureService(capture, captureTask, silentLogger, { random: () => 0.5 });
  const first = service.refresh();
  const second = service.refresh();
  assert.equal(first, second);
  await first;
  assert.equal(calls, 2);
  assert.equal(service.lastAttemptCount, 2);
  assert.equal(service.lastError, null);
});

test("does not retry authentication and exhausts transient retries safely", async () => {
  let authenticationCalls = 0;
  const authentication = new CaptureService({ async capture() {
    authenticationCalls += 1;
    throw new CaptureError(FAILURE_CATEGORIES.AUTHENTICATION, new Error("token must stay private"));
  } }, { ...task, retryAttempts: 3, retryInitialDelaySeconds: 0, retryMaximumDelaySeconds: 0 }, silentLogger);
  await authentication.refresh();
  assert.equal(authenticationCalls, 1);
  assert.equal(authentication.status().lastError, "authentication");
  assert.doesNotMatch(JSON.stringify(authentication.status()), /token must stay private/);

  let transientCalls = 0;
  const exhausted = new CaptureService({ async capture() {
    transientCalls += 1;
    throw new CaptureError(FAILURE_CATEGORIES.READINESS_TIMEOUT);
  } }, { ...task, retryAttempts: 2, retryInitialDelaySeconds: 0, retryMaximumDelaySeconds: 0 }, silentLogger);
  await exhausted.refresh();
  assert.equal(transientCalls, 3);
  assert.equal(exhausted.lastAttemptCount, 3);
  assert.equal(exhausted.status().lastError, "readiness_timeout");
});

test("retains a bounded sanitized capture error log only in detailed status", async () => {
  let calls = 0;
  const secret = "super-secret-token";
  const service = new CaptureService({ async capture() {
    calls += 1;
    throw new CaptureError(
      FAILURE_CATEGORIES.NAVIGATION,
      new Error(`Attempt ${calls} failed at https://ha.local/path?access_token=${secret} with Authorization: Bearer another-token`),
    );
  } }, {
    ...task, retryAttempts: 24, retryInitialDelaySeconds: 0, retryMaximumDelaySeconds: 0,
  }, silentLogger, { redactions: [secret] });

  await service.refresh();
  const publicStatus = service.status();
  const detailedStatus = service.status(new Date(), true);
  assert.equal("errorLog" in publicStatus, false);
  assert.equal(detailedStatus.errorLog.length, 20);
  assert.equal(detailedStatus.errorLog[0].attempt, 25);
  assert.equal(detailedStatus.errorLog[19].attempt, 6);
  assert.match(detailedStatus.errorLog[0].message, /Attempt 25 failed/);
  assert.match(detailedStatus.errorLog[0].message, /access_token=\[REDACTED\]/);
  assert.match(detailedStatus.errorLog[0].message, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(detailedStatus), /super-secret-token|another-token/);
});

test("another task runs during backoff and shutdown cancels the retry", async () => {
  let slowCalls = 0;
  const slow = new CaptureService({ async capture() {
    slowCalls += 1;
    throw new CaptureError(FAILURE_CATEGORIES.NAVIGATION);
  } }, { ...task, id: "slow", retryAttempts: 2, retryInitialDelaySeconds: 30, retryMaximumDelaySeconds: 30 }, silentLogger);
  const slowRefresh = slow.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(slow.retryTimer);

  let fastCalls = 0;
  const fast = new CaptureService({ async capture() { fastCalls += 1; return { capturedAt: new Date() }; } }, { ...task, id: "fast" }, silentLogger);
  await fast.refresh();
  assert.equal(fastCalls, 1);
  assert.equal(slowCalls, 1);

  slow.stopSchedule();
  await slowRefresh;
  assert.equal(slowCalls, 1);
  assert.equal(slow.status().lastError, "shutdown");
});

async function httpFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ha-screenshot-http-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const morningTask = { ...task, id: "morning", outputPath: path.join(directory, "morning.png"), outputFilename: "morning.png" };
  const fallbackTask = { ...task, id: "fallback", outputPath: path.join(directory, "fallback.png"), outputFilename: "fallback.png" };
  const morningBytes = await png(800, 480, "white");
  const fallbackBytes = await png(800, 480, "black");
  await fs.writeFile(morningTask.outputPath, morningBytes);
  await fs.writeFile(fallbackTask.outputPath, fallbackBytes);
  const services = [new CaptureService({}, morningTask, silentLogger), new CaptureService({}, fallbackTask, silentLogger)];
  const replacements = [];
  const image = { id: "display", fallbackTaskId: "fallback", slots: [{ days: ["mon"], start: "06:00", end: "09:00", taskId: "morning" }] };
  const manager = {
    services,
    getService(id) { return services.find((service) => service.task.id === id); },
    getImage(id) { return id === image.id ? image : undefined; },
    resolveImage() { return services[0]; },
    configuration() { return { settings: { haUrl: "http://homeassistant.local:8123", accessToken: "secret", imageScheduleTimezone: "UTC", configUsername: "admin", configPassword: "editor-secret" }, tasks: services.map((service) => service.task), images: [image] }; },
    async replace(value) { replacements.push(value); return value; },
    refresh(id) { return this.getService(id) ? Promise.resolve() : null; },
  };
  const config = { configured: true, configUsername: "admin", configPassword: "editor-secret", imageScheduleTimezone: "UTC", images: [image] };
  const server = createApp(manager, config, { now: () => new Date("2026-08-03T07:00:00Z") }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, morningTask, fallbackTask, morningBytes, fallbackBytes, services, image, replacements };
}

test("serves direct and scheduled images without legacy aliases", async (t) => {
  const { base, morningBytes } = await httpFixture(t);
  const direct = await fetch(`${base}/screenshots/morning`);
  assert.equal(direct.status, 200); assert.equal(direct.headers.get("cache-control"), "no-cache, must-revalidate");
  assert.deepEqual(Buffer.from(await direct.arrayBuffer()), morningBytes);
  const scheduled = await fetch(`${base}/images/display`);
  assert.equal(scheduled.status, 200); assert.deepEqual(Buffer.from(await scheduled.arrayBuffer()), morningBytes);
  assert.equal((await fetch(`${base}/screenshots/morning.png`)).status, 404);
  assert.equal((await fetch(`${base}/snapshot`)).status, 404);
  assert.equal((await fetch(`${base}/api/screenshots`)).status, 404);
  assert.equal((await fetch(`${base}/images/missing`)).status, 404);
});

test("supports conditional GET and HEAD without transferring unchanged images", async (t) => {
  const { base, morningBytes } = await httpFixture(t);
  const initial = await fetch(`${base}/screenshots/morning`);
  const etag = initial.headers.get("etag");
  const lastModified = initial.headers.get("last-modified");
  assert.ok(etag); assert.ok(lastModified);
  assert.equal(Number(initial.headers.get("content-length")), morningBytes.length);
  assert.equal(initial.headers.get("content-type"), "image/png");
  await initial.arrayBuffer();

  const byTag = await fetch(`${base}/screenshots/morning`, { headers: { "if-none-match": etag } });
  assert.equal(byTag.status, 304); assert.equal((await byTag.arrayBuffer()).byteLength, 0);
  assert.equal(byTag.headers.get("cache-control"), "no-cache, must-revalidate");
  const byDate = await fetch(`${base}/screenshots/morning`, { headers: { "if-modified-since": lastModified } });
  assert.equal(byDate.status, 304);
  const head = await fetch(`${base}/screenshots/morning`, { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(Number(head.headers.get("content-length")), morningBytes.length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test("changes validators after replacement and when a feed switches tasks", async (t) => {
  const { base, morningTask, services } = await httpFixture(t);
  const directBefore = await fetch(`${base}/screenshots/morning`);
  const directTag = directBefore.headers.get("etag");
  await directBefore.arrayBuffer();
  await fs.writeFile(morningTask.outputPath, await png(800, 480, "red"));
  const directAfter = await fetch(`${base}/screenshots/morning`, { headers: { "if-none-match": directTag } });
  assert.equal(directAfter.status, 200); assert.notEqual(directAfter.headers.get("etag"), directTag);

  const feedTag = directAfter.headers.get("etag");
  const switchedManager = {
    services,
    getService(id) { return services.find((service) => service.task.id === id); },
    getImage() { return { id: "display" }; },
    resolveImage() { return services[1]; },
  };
  const app = createApp(switchedManager, { configured: true, configUsername: "admin", configPassword: "editor-secret", images: [], imageScheduleTimezone: "UTC" });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const switched = await fetch(`http://127.0.0.1:${server.address().port}/images/display`, { headers: { "if-none-match": feedTag } });
  assert.equal(switched.status, 200); assert.notEqual(switched.headers.get("etag"), feedTag);
});

test("restores verified images and marks them stale after three refresh periods", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ha-screenshot-restore-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, "restored.png");
  await fs.writeFile(outputPath, await png());
  const capturedAt = new Date("2026-08-03T00:00:00Z");
  await fs.utimes(outputPath, capturedAt, capturedAt);
  const restoredTask = { ...task, outputPath, refreshIntervalSeconds: 20 };
  const service = new CaptureService({}, restoredTask, silentLogger);
  assert.equal(service.status(new Date("2026-08-03T00:01:00Z")).ready, true);
  const stale = service.status(new Date("2026-08-03T00:01:01Z"));
  assert.equal(stale.ready, false); assert.equal(stale.stale, true); assert.equal(stale.imageAvailable, true);

  await fs.writeFile(outputPath, "not an image");
  assert.equal(service.status(new Date("2026-08-03T00:01:01Z")).imageAvailable, false);
});

test("serves stale last-good images while health reports degraded", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ha-screenshot-stale-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const staleTask = { ...task, outputPath: path.join(directory, "stale.png"), refreshIntervalSeconds: 20 };
  await fs.writeFile(staleTask.outputPath, await png());
  const capturedAt = new Date("2026-08-03T00:00:00Z");
  await fs.utimes(staleTask.outputPath, capturedAt, capturedAt);
  const service = new CaptureService({ async capture() { throw new Error("private upstream detail"); } }, staleTask, silentLogger);
  await service.refresh();
  const manager = {
    services: [service],
    getService(id) { return id === staleTask.id ? service : undefined; },
    getImage() { return undefined; },
  };
  const now = () => new Date("2026-08-03T00:01:01Z");
  const server = createApp(manager, { configured: true, configUsername: "admin", configPassword: "editor-secret", images: [], imageScheduleTimezone: "UTC" }, { now }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const healthResponse = await fetch(`${base}/healthz`);
  const health = await healthResponse.json();
  assert.equal(healthResponse.status, 503); assert.equal(health.status, "degraded");
  assert.equal(health.tasks[0].stale, true); assert.equal(health.tasks[0].lastError, "navigation");
  assert.doesNotMatch(JSON.stringify(health), /private upstream detail/);
  const image = await fetch(`${base}/screenshots/test`);
  assert.equal(image.status, 200); assert.equal(image.headers.get("x-image-stale"), "true");
  const missingHead = await fetch(`${base}/screenshots/missing`, { method: "HEAD" });
  assert.equal(missingHead.status, 404); assert.equal((await missingHead.arrayBuffer()).byteLength, 0);
});

test("serves JPEG metadata and rejects a wrong-sized persisted image", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ha-screenshot-jpeg-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const jpegTask = { ...task, id: "jpeg", format: "jpeg", outputFilename: "jpeg.jpg", outputPath: path.join(directory, "jpeg.jpg") };
  const jpegBytes = await sharp({ create: { width: 800, height: 480, channels: 3, background: "white" } }).jpeg().toBuffer();
  await fs.writeFile(jpegTask.outputPath, jpegBytes);
  const service = new CaptureService({}, jpegTask, silentLogger);
  const manager = { services: [service], getService() { return service; }, getImage() { return undefined; } };
  const server = createApp(manager, { configured: true, configUsername: "admin", configPassword: "editor-secret", images: [], imageScheduleTimezone: "UTC" }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/screenshots/jpeg`);
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal(Number(response.headers.get("content-length")), jpegBytes.length);

  await fs.writeFile(jpegTask.outputPath, await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } }).jpeg().toBuffer());
  assert.equal(service.status().imageAvailable, false);
});

test("serves the authenticated gallery and public health metadata", async (t) => {
  const { base, services } = await httpFixture(t);
  services[0].recordCaptureError(new Error("admin-only upstream detail"), 1);
  assert.equal((await fetch(`${base}/`)).status, 401);
  const authorization = `Basic ${Buffer.from("admin:editor-secret").toString("base64")}`;
  const pageResponse = await fetch(`${base}/`, { headers: { authorization } }); const page = await pageResponse.text();
  const csp = pageResponse.headers.get("content-security-policy");
  assert.doesNotMatch(csp, /https?:|cdn\.jsdelivr\.net/);
  assert.match(csp, /style-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(page, /(?:href|src)=["']https?:/);
  assert.match(page, /vendor\/bootstrap\/bootstrap\.min\.css/);
  assert.match(page, /vendor\/bootstrap\/bootstrap\.bundle\.min\.js/);
  const css = await fetch(`${base}/vendor/bootstrap/bootstrap.min.css`);
  const javascript = await fetch(`${base}/vendor/bootstrap/bootstrap.bundle.min.js`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /^text\/css/);
  assert.match(await css.text(), /Bootstrap\s+v5\.3\.8/);
  assert.equal(javascript.status, 200);
  assert.match(javascript.headers.get("content-type"), /javascript/);
  assert.match(await javascript.text(), /Bootstrap v5\.3\.8/);
  const galleryResponse = await fetch(`${base}/api/gallery`); const gallery = await galleryResponse.json();
  assert.equal(galleryResponse.status, 200); assert.equal(gallery.images[0].activeTaskId, "morning"); assert.equal(gallery.tasks[0].imageUrl, "/screenshots/morning");
  const healthResponse = await fetch(`${base}/healthz`); const health = await healthResponse.json();
  assert.equal(healthResponse.status, 200); assert.equal(health.images[0].activeTaskId, "morning");
  assert.doesNotMatch(JSON.stringify({ gallery, health }), /errorLog|admin-only upstream detail/);
});

test("protects configuration reads and mutations", async (t) => {
  const { base, replacements, services } = await httpFixture(t);
  services[0].recordCaptureError(new Error("authenticated diagnostic detail"), 2);
  assert.equal((await fetch(`${base}/api/config`)).status, 401);
  const authorization = `Basic ${Buffer.from("admin:editor-secret").toString("base64")}`;
  const configResponse = await fetch(`${base}/api/config`, { headers: { authorization } });
  const configBody = await configResponse.json();
  assert.equal(configResponse.status, 200);
  assert.equal(configBody.settings.accessTokenConfigured, true);
  assert.equal(configBody.settings.configPasswordConfigured, true);
  assert.equal("accessToken" in configBody.settings, false);
  assert.equal("configPassword" in configBody.settings, false);
  assert.equal(configBody.tasks[0].status.errorLog[0].attempt, 2);
  assert.match(configBody.tasks[0].status.errorLog[0].message, /authenticated diagnostic detail/);
  assert.equal((await fetch(`${base}/api/config`, { method: "PUT", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ tasks: [], images: [] }) })).status, 403);
  const update = await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: { authorization, "content-type": "application/json", "x-requested-with": "ha-screenshot" },
    body: JSON.stringify({ customCsses: [{ id: "eink", css: "ha-card {}" }], tasks: [], images: [] }),
  });
  assert.equal(update.status, 200);
  assert.deepEqual(replacements[0].customCsses, [{ id: "eink", css: "ha-card {}" }]);
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
  const galleryPage = await fetch(`${base}/`);
  const api = await fetch(`${base}/api/config`);
  const gallery = await (await fetch(`${base}/api/gallery`)).json();
  assert.equal(admin.status, 200);
  assert.equal(galleryPage.status, 200);
  assert.equal(api.status, 200);
  assert.equal((await api.json()).setupRequired, true);
  assert.equal(gallery.setupRequired, true);
  assert.equal((await fetch(`${base}/livez`)).status, 200);
  const readiness = await fetch(`${base}/healthz`);
  assert.equal(readiness.status, 503);
  assert.deepEqual(await readiness.json(), { status: "configuration_required" });
});

test("separates App public and ingress administration routes", async (t) => {
  const manager = {
    services: [],
    configuration() {
      return {
        settings: { haUrl: "http://homeassistant:8123", accessToken: "secret", imageScheduleTimezone: "UTC", configUsername: "ingress", configPassword: "managed-by-supervisor" },
        customCsses: [], tasks: [], images: [],
      };
    },
  };
  const config = { configured: false, settingsManagedExternally: true, imageScheduleTimezone: "UTC", images: [], publicBaseUrl: "" };
  const publicServer = createPublicApp(manager, config).listen(0, "127.0.0.1");
  const adminServer = createAdminApp(manager, config).listen(0, "127.0.0.1");
  await Promise.all([
    new Promise((resolve) => publicServer.once("listening", resolve)),
    new Promise((resolve) => adminServer.once("listening", resolve)),
  ]);
  t.after(() => Promise.all([
    new Promise((resolve) => publicServer.close(resolve)),
    new Promise((resolve) => adminServer.close(resolve)),
  ]));
  const publicBase = `http://127.0.0.1:${publicServer.address().port}`;
  const adminBase = `http://127.0.0.1:${adminServer.address().port}`;

  assert.equal((await fetch(`${publicBase}/api/config`)).status, 404);
  assert.equal((await fetch(`${publicBase}/admin/`)).status, 404);
  assert.equal((await fetch(`${adminBase}/admin/`)).status, 401);
  assert.equal((await fetch(`${adminBase}/admin/vendor/bootstrap/bootstrap.min.css`)).status, 401);
  const headers = { "x-remote-user-id": "home-assistant-user" };
  const pageResponse = await fetch(`${adminBase}/admin/`, { headers });
  const page = await pageResponse.text();
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get("content-security-policy"), /frame-ancestors 'self'/);
  assert.equal(pageResponse.headers.get("x-frame-options"), null);
  assert.match(page, /href="app\.css"/);
  assert.doesNotMatch(page, /(?:href|src)=["']https?:/);
  assert.equal((await fetch(`${adminBase}/admin/vendor/bootstrap/bootstrap.min.css`, { headers })).status, 200);
  assert.equal((await fetch(`${adminBase}/admin/vendor/bootstrap/bootstrap.bundle.min.js`, { headers })).status, 200);
  assert.equal((await fetch(`${adminBase}/admin/api/config`, { headers })).status, 200);
  assert.equal((await fetch(`${adminBase}/api/config`, { headers })).status, 404);
});

test("returns 503 without replacing or exposing a missing image", async (t) => {
  const { base, morningTask } = await httpFixture(t);
  await fs.rm(morningTask.outputPath);
  const response = await fetch(`${base}/images/display`); const body = await response.json();
  assert.equal(response.status, 503); assert.equal(body.error, "No screenshot is available yet for task morning");
  const head = await fetch(`${base}/images/display`, { method: "HEAD" });
  assert.equal(head.status, 503); assert.equal((await head.arrayBuffer()).byteLength, 0);
});
