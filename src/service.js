import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const publicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const pageCsp = "default-src 'self'; img-src 'self' data:; style-src 'self' https://cdn.jsdelivr.net; style-src-attr 'unsafe-inline'; script-src 'self' https://cdn.jsdelivr.net; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

export class CaptureService {
  constructor(capture, task, logger = console) {
    this.capture = capture;
    this.task = task;
    this.logger = logger;
    this.lastCaptureAt = null;
    this.lastError = null;
    this.inFlight = null;
    this.timer = null;
  }

  refresh() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.capture.capture(this.task)
      .then(({ capturedAt }) => {
        this.lastCaptureAt = capturedAt;
        this.lastError = null;
        this.logger.info(`Captured task ${this.task.id} at ${this.task.width}x${this.task.height} on ${capturedAt.toISOString()}`);
      })
      .catch((error) => {
        this.lastError = error;
        this.logger.error(`Screenshot task ${this.task.id} failed`, error);
      })
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  startSchedule() {
    void this.refresh();
    if (this.task.refreshIntervalSeconds > 0) {
      this.timer = setInterval(() => void this.refresh(), this.task.refreshIntervalSeconds * 1000);
      this.timer.unref();
    }
  }

  stopSchedule() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function taskStatus(service, includeErrorDetail = false) {
  const ready = fs.existsSync(service.task.outputPath);
  return {
    id: service.task.id,
    ready,
    capturing: Boolean(service.inFlight),
    lastCaptureAt: service.lastCaptureAt?.toISOString() || null,
    lastError: service.lastError ? (includeErrorDetail ? service.lastError.message : "Capture failed") : null,
  };
}

function sendImage(service, response) {
  if (!fs.existsSync(service.task.outputPath)) {
    return response.status(503).json({ error: `No screenshot is available yet for task ${service.task.id}` });
  }
  response.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Expires: "0",
    Pragma: "no-cache",
  });
  return response.type(service.task.format === "jpeg" ? "jpeg" : "png").sendFile(service.task.outputPath);
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

function galleryTask(service) {
  return {
    id: service.task.id,
    width: service.task.width,
    height: service.task.height,
    format: service.task.format,
    refreshIntervalSeconds: service.task.refreshIntervalSeconds,
    imageUrl: `/screenshots/${service.task.id}`,
    status: taskStatus(service),
  };
}

function adminConfiguration(manager, config, now) {
  const statusById = new Map(manager.services.map((service) => [service.task.id, taskStatus(service, true)]));
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
    tasks: definition.tasks.map((task) => ({
      ...task, imageUrl: `/screenshots/${task.id}`, status: statusById.get(task.id),
    })),
    images: definition.images.map((image) => {
      const service = manager.resolveImage(image, now());
      return {
        ...image,
        imageUrl: `/images/${image.id}`,
        activeTaskId: service.task.id,
        width: service.task.width,
        height: service.task.height,
        format: service.task.format,
        status: taskStatus(service, true),
      };
    }),
  };
}

export function createApp(manager, config, { now = () => new Date() } = {}) {
  const app = express();
  const requireConfigAuth = configAuth(config);
  app.disable("x-powered-by");

  app.get("/", (request, response) => {
    pageHeaders(response);
    return response.sendFile(path.join(publicDirectory, "gallery.html"));
  });
  app.get("/app.css", (request, response) => response.type("css").sendFile(path.join(publicDirectory, "app.css")));
  app.get("/gallery.js", (request, response) => response.type("js").sendFile(path.join(publicDirectory, "gallery.js")));

  app.get("/screenshots/:taskId", (request, response) => {
    const service = manager.getService(request.params.taskId);
    if (!service) return response.status(404).json({ error: "Screenshot task not found" });
    return sendImage(service, response);
  });

  app.get("/images/:imageId", (request, response) => {
    const image = manager.getImage(request.params.imageId);
    if (!image) return response.status(404).json({ error: "Scheduled image not found" });
    return sendImage(manager.resolveImage(image, now()), response);
  });

  app.get("/healthz", (request, response) => {
    const tasks = manager.services.map((service) => taskStatus(service));
    const images = config.images.map((image) => {
      const service = manager.resolveImage(image, now());
      return { id: image.id, activeTaskId: service.task.id, ready: fs.existsSync(service.task.outputPath) };
    });
    const ready = tasks.length > 0 && tasks.every((task) => task.ready);
    return response.status(ready ? 200 : 503).json({ status: ready ? "ok" : "starting", tasks, images });
  });

  app.get("/api/gallery", (request, response) => {
    response.set("Cache-Control", "no-store").json({
      setupRequired: !config.configured,
      timezone: config.imageScheduleTimezone,
      images: config.images.map((image) => {
        const service = manager.resolveImage(image, now());
        return {
          id: image.id,
          width: service.task.width,
          height: service.task.height,
          format: service.task.format,
          imageUrl: `/images/${image.id}`,
          activeTaskId: service.task.id,
          status: taskStatus(service),
        };
      }),
      tasks: manager.services.map(galleryTask),
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
