import fs from "node:fs/promises";
import path from "node:path";
import { configurationToDefinition, normalizeConfiguration, taskToDefinition } from "./config.js";
import { CaptureService } from "./service.js";
import { resolveImageTaskId } from "./schedule.js";

export class TaskManager {
  constructor(capture, config, logger = console, { activateCapture = async () => {} } = {}) {
    this.capture = capture;
    this.config = config;
    this.logger = logger;
    this.activateCapture = activateCapture;
    this.services = this.createServices(config.tasks, config);
    this.updateQueue = Promise.resolve();
  }

  createServices(tasks, config = this.config) {
    const redactions = [config.accessToken, config.configPassword];
    return tasks.map((task) => new CaptureService(this.capture, task, this.logger, { redactions }));
  }

  start() {
    for (const service of this.services) service.startSchedule();
  }

  async stop() {
    await this.updateQueue;
    await this.stopServices();
  }

  async stopServices() {
    for (const service of this.services) service.stopSchedule();
    await Promise.all(this.services.map((service) => service.inFlight));
  }

  getService(id) {
    return this.services.find((service) => service.task.id === id);
  }

  getImage(id) {
    return this.config.images.find((image) => image.id === id);
  }

  getImageByUrlId(urlId) {
    return this.config.images.find((image) => image.urlIds.includes(urlId));
  }

  resolveImage(image, now = new Date()) {
    return this.getService(resolveImageTaskId(image, this.config.imageScheduleTimezone, now));
  }

  definitions() {
    return this.services.map((service) => taskToDefinition(service.task));
  }

  configuration() {
    return configurationToDefinition({
      haUrl: this.config.haUrl,
      accessToken: this.config.accessToken,
      imageScheduleTimezone: this.config.imageScheduleTimezone,
      configUsername: this.config.configUsername,
      configPassword: this.config.configPassword,
      customCsses: this.config.customCsses,
      tasks: this.services.map((service) => service.task),
      images: this.config.images,
    }, { includeSettings: true });
  }

  replace(definition) {
    const operation = this.updateQueue.then(() => this.replaceNow(definition));
    this.updateQueue = operation.catch(() => {});
    return operation;
  }

  async replaceNow(definition) {
    const suppliedSettings = definition?.settings || {};
    const settings = this.config.settingsManagedExternally ? {
      haUrl: this.config.haUrl,
      accessToken: this.config.accessToken,
      imageScheduleTimezone: this.config.imageScheduleTimezone,
      configUsername: this.config.configUsername,
      configPassword: this.config.configPassword,
    } : {
      haUrl: suppliedSettings.haUrl ?? this.config.haUrl,
      accessToken: suppliedSettings.accessToken || this.config.accessToken,
      imageScheduleTimezone: suppliedSettings.imageScheduleTimezone ?? this.config.imageScheduleTimezone,
      configUsername: suppliedSettings.configUsername ?? this.config.configUsername,
      configPassword: suppliedSettings.configPassword || this.config.configPassword,
    };
    const normalized = normalizeConfiguration({
      ...definition,
      customCsses: definition?.customCsses ?? this.config.customCsses,
      settings,
    }, this.config);
    const persisted = configurationToDefinition(normalized, { includeSettings: !this.config.settingsManagedExternally });
    const serialized = `${JSON.stringify(persisted, null, 2)}\n`;
    const temporaryPath = path.join(
      path.dirname(this.config.configFile),
      `.${path.basename(this.config.configFile)}.${process.pid}.tmp`,
    );

    if (this.services.length === 0 && normalized.tasks.length > 0) await this.activateCapture();
    await fs.writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    try {
      await fs.rename(temporaryPath, this.config.configFile);
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }

    const connectionChanged = this.config.haUrl !== normalized.haUrl
      || this.config.accessToken !== normalized.accessToken;
    const tasksChanged = connectionChanged
      || JSON.stringify(this.config.customCsses) !== JSON.stringify(persisted.customCsses)
      || JSON.stringify(this.definitions()) !== JSON.stringify(persisted.tasks);
    if (tasksChanged) {
      await this.stopServices();
      this.config.tasks = normalized.tasks;
      this.services = this.createServices(normalized.tasks, normalized);
    }
    this.config.haUrl = normalized.haUrl;
    this.config.accessToken = normalized.accessToken;
    this.config.imageScheduleTimezone = normalized.imageScheduleTimezone;
    this.config.configUsername = normalized.configUsername;
    this.config.configPassword = normalized.configPassword;
    this.config.customCsses = normalized.customCsses;
    this.config.configured = true;
    this.config.images = normalized.images;
    if (tasksChanged) this.start();
    return this.configuration();
  }

  refresh(id) {
    const service = this.getService(id);
    if (!service) return null;
    return service.refresh();
  }
}
