import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { inspectImageFile } from "./image-file.js";
import { captureFailure, FAILURE_CATEGORIES } from "./capture.js";

const publicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const bootstrapDirectory = path.join(publicDirectory, "vendor/bootstrap");
const publicPageCsp = "default-src 'self'; img-src 'self' data:; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const ingressPageCsp = "default-src 'self'; img-src 'self' data:; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'";
const maximumCaptureErrorEntries = 20;

function redactCaptureError(value, redactions) {
  let result = String(value || "Unknown capture error");
  for (const sensitiveValue of redactions) {
    if (sensitiveValue) result = result.split(String(sensitiveValue)).join("[REDACTED]");
  }
  return result
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/([?&](?:access_?token|token|api_?key|password|secret)=)[^&#\s]*/gi, "$1[REDACTED]")
    .replace(/\b(access_?token|token|api_?key|password|secret)\s*[:=]\s*["']?[^"'\s,;}]+/gi, "$1=[REDACTED]");
}

function captureErrorDetail(error, redactions) {
  const messages = [];
  const visited = new Set();
  let current = error;
  while (current && !visited.has(current) && messages.length < 5) {
    visited.add(current);
    const message = redactCaptureError(current.message || current, redactions).trim();
    if (message && !messages.includes(message)) messages.push(message);
    current = current.cause;
  }
  return messages.join("\nCaused by: ").slice(0, 4000);
}

export class CaptureService {
  constructor(capture, task, logger = console, {
    now = () => new Date(), random = Math.random, redactions = [],
  } = {}) {
    this.capture = capture;
    this.task = task;
    this.logger = logger;
    this.now = now;
    this.random = random;
    this.lastCaptureAt = null;
    this.lastAttemptAt = null;
    this.captureStartedAt = null;
    this.lastCaptureDurationMs = null;
    this.consecutiveFailures = 0;
    this.nextCaptureAt = null;
    this.lastError = null;
    this.errorLog = [];
    this.redactions = redactions.filter(Boolean);
    this.lastAttemptCount = 0;
    this.inFlight = null;
    this.timer = null;
    this.retryTimer = null;
    this.cancelRetry = null;
    this.stopping = false;
    this.imageMetadata = null;
    this.imageSignature = null;
    const metadata = this.loadImageMetadata();
    if (metadata) this.lastCaptureAt = metadata.lastModified;
  }

  loadImageMetadata(force = false) {
    let stat;
    try {
      stat = fs.statSync(this.task.outputPath);
    } catch {
      this.imageMetadata = null;
      this.imageSignature = null;
      return null;
    }
    const signature = `${stat.size}:${stat.mtimeMs}`;
    const changed = signature !== this.imageSignature;
    if (!force && signature === this.imageSignature) return this.imageMetadata;
    this.imageSignature = signature;
    try {
      this.imageMetadata = inspectImageFile(this.task.outputPath, this.task);
      if (changed) this.lastCaptureAt = this.imageMetadata.lastModified;
    } catch {
      this.imageMetadata = null;
    }
    return this.imageMetadata;
  }

  status(at = this.now(), includeErrorDetail = false) {
    const metadata = this.loadImageMetadata();
    const imageAt = this.lastCaptureAt || metadata?.lastModified || null;
    const imageAgeSeconds = imageAt ? Math.max(0, Math.floor((at.getTime() - imageAt.getTime()) / 1000)) : null;
    const maximumAge = this.task.refreshIntervalSeconds > 0 ? this.task.refreshIntervalSeconds * 3 : 0;
    const stale = Boolean(metadata && maximumAge > 0 && imageAgeSeconds > maximumAge);
    const status = {
      id: this.task.id,
      ready: Boolean(metadata) && !stale,
      stale,
      imageAvailable: Boolean(metadata),
      imageAgeSeconds,
      capturing: Boolean(this.inFlight),
      captureStartedAt: this.captureStartedAt?.toISOString() || null,
      lastSuccessAt: imageAt?.toISOString() || null,
      lastCaptureAt: imageAt?.toISOString() || null,
      lastAttemptAt: this.lastAttemptAt?.toISOString() || null,
      lastCaptureDurationMs: this.lastCaptureDurationMs,
      consecutiveFailures: this.consecutiveFailures,
      lastAttemptCount: this.lastAttemptCount,
      nextCaptureAt: this.nextCaptureAt?.toISOString() || null,
      lastError: this.lastError?.category || null,
    };
    if (includeErrorDetail) status.errorLog = this.errorLog.map((entry) => ({ ...entry }));
    return status;
  }

  recordCaptureError(error, attempt) {
    const failure = captureFailure(error);
    const entry = {
      at: this.now().toISOString(),
      category: failure.category,
      attempt,
      message: captureErrorDetail(failure, this.redactions),
    };
    this.errorLog.unshift(entry);
    this.errorLog.length = Math.min(this.errorLog.length, maximumCaptureErrorEntries);
    return failure;
  }

  refresh() {
    if (this.inFlight) return this.inFlight;
    const startedAt = this.now();
    this.captureStartedAt = startedAt;
    this.lastAttemptCount = 0;
    this.inFlight = this.captureWithRetries()
      .then((result) => {
        if (!result) return;
        const { capturedAt } = result;
        const metadata = this.loadImageMetadata(true);
        if (!metadata) throw captureFailure(new Error("Capture output validation failed"), FAILURE_CATEGORIES.SCREENSHOT_WRITE);
        this.lastCaptureAt = capturedAt || metadata.lastModified;
        this.lastError = null;
        this.consecutiveFailures = 0;
        this.logger.info(`Captured task ${this.task.id} at ${this.task.width}x${this.task.height} on ${this.lastCaptureAt.toISOString()}`);
      })
      .catch((error) => {
        this.lastError = captureFailure(error);
        this.consecutiveFailures += 1;
        this.logger.error(`Screenshot task ${this.task.id} failed: ${this.lastError.category}`);
      })
      .finally(() => {
        this.lastCaptureDurationMs = Math.max(0, this.now().getTime() - startedAt.getTime());
        this.captureStartedAt = null;
        this.inFlight = null;
      });
    return this.inFlight;
  }

  async captureWithRetries() {
    const retries = this.task.retryAttempts ?? 0;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (this.stopping) throw captureFailure(null, FAILURE_CATEGORIES.SHUTDOWN);
      this.lastAttemptAt = this.now();
      this.lastAttemptCount = attempt + 1;
      try {
        const result = await this.capture.capture(this.task);
        if (!this.loadImageMetadata(true)) {
          throw captureFailure(new Error("Capture output validation failed"), FAILURE_CATEGORIES.SCREENSHOT_WRITE);
        }
        return result;
      } catch (error) {
        const failure = this.recordCaptureError(error, attempt + 1);
        const transient = new Set([
          FAILURE_CATEGORIES.NAVIGATION,
          FAILURE_CATEGORIES.READINESS_TIMEOUT,
          FAILURE_CATEGORIES.SCREENSHOT_WRITE,
          FAILURE_CATEGORIES.BROWSER_UNAVAILABLE,
        ]).has(failure.category);
        if (!transient || attempt >= retries || this.stopping) throw failure;
        const initial = (this.task.retryInitialDelaySeconds ?? 0) * 1000;
        const maximum = (this.task.retryMaximumDelaySeconds ?? this.task.retryInitialDelaySeconds ?? 0) * 1000;
        const bounded = Math.min(maximum, initial * (2 ** attempt));
        const delay = Math.min(maximum, Math.round(bounded * (0.9 + this.random() * 0.2)));
        this.logger.info(`Retrying screenshot task ${this.task.id} after ${failure.category}`);
        if (!await this.waitForRetry(delay)) throw captureFailure(null, FAILURE_CATEGORIES.SHUTDOWN);
      }
    }
    return null;
  }

  waitForRetry(delay) {
    if (this.stopping) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.cancelRetry = () => resolve(false);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.cancelRetry = null;
        resolve(true);
      }, delay);
      this.retryTimer.unref?.();
    });
  }

  startSchedule() {
    this.stopping = false;
    void this.refresh();
    if (this.task.refreshIntervalSeconds > 0) {
      const intervalMs = this.task.refreshIntervalSeconds * 1000;
      this.nextCaptureAt = new Date(this.now().getTime() + intervalMs);
      this.timer = setInterval(() => {
        this.nextCaptureAt = new Date(this.now().getTime() + intervalMs);
        void this.refresh();
      }, intervalMs);
      this.timer.unref();
    }
  }

  stopSchedule() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.cancelRetry?.();
    this.retryTimer = null;
    this.cancelRetry = null;
    this.timer = null;
    this.nextCaptureAt = null;
  }
}

function sendImage(service, request, response, at) {
  const metadata = service.loadImageMetadata();
  if (!metadata) {
    return response.status(503).json({ error: `No screenshot is available yet for task ${service.task.id}` });
  }
  const etag = `"${service.task.id}-${metadata.hash}"`;
  const lastModified = metadata.lastModified.toUTCString();
  const status = service.status(at);
  response.set({
    "Cache-Control": "no-cache, must-revalidate",
    Expires: "0",
    "Content-Type": service.task.format === "jpeg" ? "image/jpeg" : "image/png",
    "Content-Length": String(metadata.size),
    ETag: etag,
    "Last-Modified": lastModified,
    "X-Image-Captured-At": status.lastSuccessAt,
    "X-Image-Stale": String(status.stale),
  });
  const ifNoneMatch = request.get("if-none-match");
  const tagMatches = ifNoneMatch && (ifNoneMatch.trim() === "*" || ifNoneMatch.split(",").some((value) => value.trim().replace(/^W\//, "") === etag));
  let notModified = Boolean(tagMatches);
  if (!ifNoneMatch) {
    const modifiedSince = Date.parse(request.get("if-modified-since") || "");
    notModified = Number.isFinite(modifiedSince)
      && Math.floor(metadata.lastModified.getTime() / 1000) <= Math.floor(modifiedSince / 1000);
  }
  if (notModified) return response.status(304).end();
  return response.sendFile(service.task.outputPath);
}

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function configAuth(config) {
  return (request, response, next) => {
    if (!config.configured) return next();
    const encoded = request.get("authorization")?.match(/^Basic\s+(.+)$/i)?.[1];
    let username = "";
    let password = "";
    if (encoded) {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator >= 0) {
        username = decoded.slice(0, separator);
        password = decoded.slice(separator + 1);
      }
    }
    if (safeEqual(username, config.configUsername) && safeEqual(password, config.configPassword)) return next();
    response.set("WWW-Authenticate", 'Basic realm="Home Assistant Screenshot Configuration", charset="UTF-8"');
    return response.status(401).send("Authentication required");
  };
}

function ingressAuth(request, response, next) {
  if (request.get("x-remote-user-id")) return next();
  return response.status(401).send("Home Assistant ingress authentication required");
}

function requireSameOriginMutation(request, response, next) {
  if (request.get("x-requested-with") !== "ha-screenshot") {
    return response.status(403).json({ error: "Missing mutation request header" });
  }
  return next();
}

function pageHeaders(response, { admin = false, ingress = false } = {}) {
  response.set({
    "Cache-Control": "no-store",
    "Content-Security-Policy": ingress ? ingressPageCsp : publicPageCsp,
    "X-Content-Type-Options": "nosniff",
    ...(admin && !ingress ? { "X-Frame-Options": "DENY" } : {}),
  });
}

function galleryTask(service, at) {
  return {
    id: service.task.id,
    width: service.task.width,
    height: service.task.height,
    format: service.task.format,
    refreshIntervalSeconds: service.task.refreshIntervalSeconds,
    imageUrl: `/screenshots/${service.task.id}`,
    status: service.status(at),
  };
}

function adminConfiguration(manager, config, now, { previewPrefix = "", publicBaseUrl = "" } = {}) {
  const at = now();
  const statusById = new Map(manager.services.map((service) => [service.task.id, service.status(at, true)]));
  const definition = manager.configuration();
  return {
    setupRequired: !config.configured,
    settingsManagedExternally: Boolean(config.settingsManagedExternally),
    publicBaseUrl: config.publicBaseUrl || "",
    settings: {
      haUrl: definition.settings.haUrl,
      accessTokenConfigured: Boolean(definition.settings.accessToken),
      imageScheduleTimezone: definition.settings.imageScheduleTimezone,
      configUsername: definition.settings.configUsername,
      configPasswordConfigured: Boolean(definition.settings.configPassword),
    },
    customCsses: definition.customCsses ?? [],
    tasks: definition.tasks.map((task) => ({
      ...task,
      imageUrl: `${previewPrefix}/screenshots/${task.id}`,
      publicUrl: `${publicBaseUrl}/screenshots/${task.id}`,
      status: statusById.get(task.id),
    })),
    images: definition.images.map((image) => {
      const service = manager.resolveImage(image, at);
      return {
        ...image,
        urls: image.urlIds.map((urlId) => ({
          id: urlId,
          imageUrl: `${previewPrefix}/images/${urlId}`,
          publicUrl: `${publicBaseUrl}/images/${urlId}`,
        })),
        activeTaskId: service.task.id,
        width: service.task.width,
        height: service.task.height,
        format: service.task.format,
        status: service.status(at, true),
      };
    }),
  };
}

function addPublicRoutes(app, manager, config, { now, galleryAuth = (request, response, next) => next() }) {
  app.get("/", galleryAuth, (request, response) => {
    pageHeaders(response);
    return response.sendFile(path.join(publicDirectory, "gallery.html"));
  });
  app.get("/app.css", (request, response) => response.type("css").sendFile(path.join(publicDirectory, "app.css")));
  app.get("/gallery.js", (request, response) => response.type("js").sendFile(path.join(publicDirectory, "gallery.js")));

  app.get("/screenshots/:taskId", (request, response) => {
    if (!config.configured) return response.status(503).json({ error: "Configuration required" });
    const service = manager.getService(request.params.taskId);
    if (!service) return response.status(404).json({ error: "Screenshot task not found" });
    return sendImage(service, request, response, now());
  });

  app.get("/images/:urlId", (request, response) => {
    if (!config.configured) return response.status(503).json({ error: "Configuration required" });
    const image = manager.getImageByUrlId(request.params.urlId);
    if (!image) return response.status(404).json({ error: "Scheduled image URL not found" });
    const at = now();
    return sendImage(manager.resolveImage(image, at), request, response, at);
  });

  app.get("/healthz", (request, response) => {
    if (!config.configured) return response.status(503).json({ status: "configuration_required" });
    const at = now();
    const tasks = manager.services.map((service) => service.status(at));
    const images = config.images.map((image) => {
      const service = manager.resolveImage(image, at);
      const status = service.status(at);
      return { id: image.id, urlIds: image.urlIds, activeTaskId: service.task.id, ready: status.ready, stale: status.stale };
    });
    const ready = tasks.length > 0 && tasks.every((task) => task.ready);
    const state = ready ? "ok" : tasks.some((task) => task.stale) ? "degraded" : "starting";
    return response.status(ready ? 200 : 503).json({ status: state, tasks, images });
  });

  app.get("/livez", (request, response) => response.json({ status: "ok" }));

  app.get("/api/gallery", (request, response) => {
    const at = now();
    response.set("Cache-Control", "no-store").json({
      setupRequired: !config.configured,
      timezone: config.imageScheduleTimezone,
      images: config.images.map((image) => {
        const service = manager.resolveImage(image, at);
        return {
          id: image.id,
          urlIds: image.urlIds,
          width: service.task.width,
          height: service.task.height,
          format: service.task.format,
          imageUrl: `/images/${image.urlIds[0]}`,
          imageUrls: image.urlIds.map((urlId) => `/images/${urlId}`),
          activeTaskId: service.task.id,
          status: service.status(at),
        };
      }),
      tasks: manager.services.map((service) => galleryTask(service, at)),
    });
  });
}

function addAdminRoutes(app, manager, config, {
  now, auth, ingress = false, apiPrefixes = ["/admin/api"], previewPrefix = "/admin/preview",
  previewUrlPrefix = "preview",
} = {}) {
  const configuration = () => adminConfiguration(manager, config, now, {
    previewPrefix: previewUrlPrefix,
    publicBaseUrl: config.publicBaseUrl || "",
  });

  app.use("/admin", auth, (request, response, next) => {
    pageHeaders(response, { admin: true, ingress });
    next();
  }, express.static(publicDirectory));

  app.get(`${previewPrefix}/screenshots/:taskId`, auth, (request, response) => {
    const service = manager.getService(request.params.taskId);
    if (!service) return response.status(404).json({ error: "Screenshot task not found" });
    return sendImage(service, request, response, now());
  });
  app.get(`${previewPrefix}/images/:urlId`, auth, (request, response) => {
    const image = manager.getImageByUrlId(request.params.urlId);
    if (!image) return response.status(404).json({ error: "Scheduled image URL not found" });
    const at = now();
    return sendImage(manager.resolveImage(image, at), request, response, at);
  });

  for (const apiPrefix of apiPrefixes) {
    app.use(`${apiPrefix}/config`, auth, express.json({ limit: "512kb" }));
    app.get(`${apiPrefix}/config`, (request, response) => response.set("Cache-Control", "no-store").json(configuration()));
    app.put(`${apiPrefix}/config`, requireSameOriginMutation, async (request, response) => {
      try {
        await manager.replace({
          settings: request.body?.settings,
          customCsses: request.body?.customCsses,
          tasks: request.body?.tasks,
          images: request.body?.images,
        });
        return response.json(configuration());
      } catch (error) {
        return response.status(400).json({ error: error.message });
      }
    });
    app.post(`${apiPrefix}/tasks/:id/capture`, auth, requireSameOriginMutation, (request, response) => {
      const capture = manager.refresh(request.params.id);
      if (!capture) return response.status(404).json({ error: "Screenshot task not found" });
      return response.status(202).json({ status: "capturing" });
    });
  }
}

function newApp() {
  const app = express();
  app.disable("x-powered-by");
  app.get("/vendor/bootstrap/bootstrap.min.css", (request, response) => response.type("css").sendFile(path.join(bootstrapDirectory, "bootstrap.min.css")));
  app.get("/vendor/bootstrap/bootstrap.bundle.min.js", (request, response) => response.type("js").sendFile(path.join(bootstrapDirectory, "bootstrap.bundle.min.js")));
  return app;
}

export function createPublicApp(manager, config, { now = () => new Date() } = {}) {
  const app = newApp();
  addPublicRoutes(app, manager, config, { now });
  return app;
}

export function createAdminApp(manager, config, { now = () => new Date() } = {}) {
  const app = newApp();
  addAdminRoutes(app, manager, config, { now, auth: ingressAuth, ingress: true });
  return app;
}

export function createApp(manager, config, { now = () => new Date() } = {}) {
  const app = newApp();
  const auth = configAuth(config);
  addPublicRoutes(app, manager, config, { now, galleryAuth: auth });
  addAdminRoutes(app, manager, config, {
    now, auth, apiPrefixes: ["/api", "/admin/api"], previewPrefix: "", previewUrlPrefix: "",
  });

  return app;
}
