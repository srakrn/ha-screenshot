import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { inspectImageFile } from "./image-file.js";

const publicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const pageCsp = "default-src 'self'; img-src 'self' data:; style-src 'self' https://cdn.jsdelivr.net; style-src-attr 'unsafe-inline'; script-src 'self' https://cdn.jsdelivr.net; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

export class CaptureService {
  constructor(capture, task, logger = console, { now = () => new Date() } = {}) {
    this.capture = capture;
    this.task = task;
    this.logger = logger;
    this.now = now;
    this.lastCaptureAt = null;
    this.lastAttemptAt = null;
    this.captureStartedAt = null;
    this.lastCaptureDurationMs = null;
    this.consecutiveFailures = 0;
    this.nextCaptureAt = null;
    this.lastError = null;
    this.inFlight = null;
    this.timer = null;
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
    const maximumAge = this.task.maximumImageAgeSeconds || 0;
    const stale = Boolean(metadata && maximumAge > 0 && imageAgeSeconds > maximumAge);
    return {
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
      nextCaptureAt: this.nextCaptureAt?.toISOString() || null,
      lastError: this.lastError ? (includeErrorDetail ? this.lastError.message : "Capture failed") : null,
    };
  }

  refresh() {
    if (this.inFlight) return this.inFlight;
    const startedAt = this.now();
    this.captureStartedAt = startedAt;
    this.lastAttemptAt = startedAt;
    this.inFlight = this.capture.capture(this.task)
      .then(({ capturedAt }) => {
        const metadata = this.loadImageMetadata(true);
        if (!metadata) throw new Error("Capture did not produce a valid image with the configured format and dimensions");
        this.lastCaptureAt = capturedAt || metadata.lastModified;
        this.lastError = null;
        this.consecutiveFailures = 0;
        this.logger.info(`Captured task ${this.task.id} at ${this.task.width}x${this.task.height} on ${this.lastCaptureAt.toISOString()}`);
      })
      .catch((error) => {
        this.lastError = error;
        this.consecutiveFailures += 1;
        this.logger.error(`Screenshot task ${this.task.id} failed`, error);
      })
      .finally(() => {
        this.lastCaptureDurationMs = Math.max(0, this.now().getTime() - startedAt.getTime());
        this.captureStartedAt = null;
        this.inFlight = null;
      });
    return this.inFlight;
  }

  startSchedule() {
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
    if (this.timer) clearInterval(this.timer);
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

function requireSameOriginMutation(request, response, next) {
  if (request.get("x-requested-with") !== "ha-screenshot") {
    return response.status(403).json({ error: "Missing mutation request header" });
  }
  return next();
}

function pageHeaders(response, isAdmin = false) {
  response.set({
    "Cache-Control": "no-store",
    "Content-Security-Policy": pageCsp,
    "X-Content-Type-Options": "nosniff",
    ...(isAdmin ? { "X-Frame-Options": "DENY" } : {}),
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

function adminConfiguration(manager, config, now) {
  const at = now();
  const statusById = new Map(manager.services.map((service) => [service.task.id, service.status(at, true)]));
  const definition = manager.configuration();
  return {
    setupRequired: !config.configured,
    settings: {
      haUrl: definition.settings.haUrl,
      accessTokenConfigured: Boolean(definition.settings.accessToken),
      imageScheduleTimezone: definition.settings.imageScheduleTimezone,
      configUsername: definition.settings.configUsername,
      configPasswordConfigured: Boolean(definition.settings.configPassword),
    },
    customCsses: definition.customCsses ?? [],
    tasks: definition.tasks.map((task) => ({
      ...task, imageUrl: `/screenshots/${task.id}`, status: statusById.get(task.id),
    })),
    images: definition.images.map((image) => {
      const service = manager.resolveImage(image, at);
      return {
        ...image,
        imageUrl: `/images/${image.id}`,
        activeTaskId: service.task.id,
        width: service.task.width,
        height: service.task.height,
        format: service.task.format,
        status: service.status(at, true),
      };
    }),
  };
}

export function createApp(manager, config, { now = () => new Date() } = {}) {
  const app = express();
  const requireConfigAuth = configAuth(config);
  app.disable("x-powered-by");

  app.get("/", requireConfigAuth, (request, response) => {
    pageHeaders(response);
    return response.sendFile(path.join(publicDirectory, "gallery.html"));
  });
  app.get("/app.css", (request, response) => response.type("css").sendFile(path.join(publicDirectory, "app.css")));
  app.get("/gallery.js", (request, response) => response.type("js").sendFile(path.join(publicDirectory, "gallery.js")));

  app.get("/screenshots/:taskId", (request, response) => {
    const service = manager.getService(request.params.taskId);
    if (!service) return response.status(404).json({ error: "Screenshot task not found" });
    return sendImage(service, request, response, now());
  });

  app.get("/images/:imageId", (request, response) => {
    const image = manager.getImage(request.params.imageId);
    if (!image) return response.status(404).json({ error: "Scheduled image not found" });
    const at = now();
    return sendImage(manager.resolveImage(image, at), request, response, at);
  });

  app.get("/healthz", (request, response) => {
    const at = now();
    const tasks = manager.services.map((service) => service.status(at));
    const images = config.images.map((image) => {
      const service = manager.resolveImage(image, at);
      const status = service.status(at);
      return { id: image.id, activeTaskId: service.task.id, ready: status.ready, stale: status.stale };
    });
    const ready = tasks.length > 0 && tasks.every((task) => task.ready);
    const state = ready ? "ok" : tasks.some((task) => task.stale) ? "degraded" : "starting";
    return response.status(ready ? 200 : 503).json({ status: state, tasks, images });
  });

  app.get("/api/gallery", (request, response) => {
    const at = now();
    response.set("Cache-Control", "no-store").json({
      setupRequired: !config.configured,
      timezone: config.imageScheduleTimezone,
      images: config.images.map((image) => {
        const service = manager.resolveImage(image, at);
        return {
          id: image.id,
          width: service.task.width,
          height: service.task.height,
          format: service.task.format,
          imageUrl: `/images/${image.id}`,
          activeTaskId: service.task.id,
          status: service.status(at),
        };
      }),
      tasks: manager.services.map((service) => galleryTask(service, at)),
    });
  });

  app.use("/admin", requireConfigAuth, (request, response, next) => {
    pageHeaders(response, true);
    next();
  }, express.static(publicDirectory));

  app.use("/api/config", requireConfigAuth, express.json({ limit: "512kb" }));
  app.get("/api/config", (request, response) => {
    return response.set("Cache-Control", "no-store").json(adminConfiguration(manager, config, now));
  });
  app.put("/api/config", requireSameOriginMutation, async (request, response) => {
    try {
      await manager.replace({
        settings: request.body?.settings,
        customCsses: request.body?.customCsses,
        tasks: request.body?.tasks,
        images: request.body?.images,
      });
      return response.json(adminConfiguration(manager, config, now));
    } catch (error) {
      return response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/tasks/:id/capture", requireConfigAuth, requireSameOriginMutation, (request, response) => {
    const capture = manager.refresh(request.params.id);
    if (!capture) return response.status(404).json({ error: "Screenshot task not found" });
    return response.status(202).json({ status: "capturing" });
  });

  return app;
}
