import fs from "node:fs";
import path from "node:path";

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function integerValue(raw, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function numberValue(raw, name, fallback, { min = 0, max = Number.MAX_VALUE } = {}) {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

function booleanValue(raw, name, fallback) {
  if (raw === undefined || raw === "") return fallback;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number" && [0, 1].includes(raw)) return Boolean(raw);
  if (typeof raw === "string") {
    if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
    if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  }
  throw new Error(`${name} must be true or false`);
}

function parseJson(value, source) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${source} must contain valid JSON: ${error.message}`);
  }
}

function stringValue(raw, name, fallback, { allowEmpty = false } = {}) {
  const value = raw ?? fallback;
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`${name} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

function timezoneValue(raw, name, fallback = "UTC") {
  const value = stringValue(raw, name, fallback);
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
  } catch {
    throw new Error(`${name} must be a valid IANA timezone such as Asia/Bangkok`);
  }
  return value;
}

function loadDefinition(configFile, { createBootstrap = true } = {}) {
  const configDirectory = path.dirname(configFile);
  try {
    fs.mkdirSync(configDirectory, { recursive: true });
    fs.accessSync(configDirectory, fs.constants.W_OK);
    if (!fs.existsSync(configFile) && createBootstrap) {
      fs.writeFileSync(configFile, `${JSON.stringify({ settings: {}, customCsses: [], tasks: [], images: [] }, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    }
    if (!fs.existsSync(configFile)) return null;
    fs.accessSync(configFile, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    throw new Error("OUTPUT_DIRECTORY and its configuration file must be readable and writable");
  }
  return parseJson(fs.readFileSync(configFile, "utf8"), "configuration file");
}

function normalizeSettings(definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw new Error("settings must be an object");
  }
  let haUrl;
  try { haUrl = new URL(definition.haUrl); } catch { throw new Error("settings.haUrl must be a valid http or https URL"); }
  if (!["http:", "https:"].includes(haUrl.protocol)) throw new Error("settings.haUrl must use http or https");
  const configPassword = stringValue(definition.configPassword, "settings.configPassword", "");
  if (configPassword === "replace-with-a-strong-editor-password") {
    throw new Error("settings.configPassword must be changed from the default value");
  }
  return {
    haUrl: haUrl.toString().replace(/\/$/, ""),
    accessToken: stringValue(definition.accessToken, "settings.accessToken", ""),
    imageScheduleTimezone: timezoneValue(definition.imageScheduleTimezone, "settings.imageScheduleTimezone"),
    configUsername: stringValue(definition.configUsername, "settings.configUsername", "admin"),
    configPassword,
  };
}

export function normalizeCustomCsses(definitions = []) {
  if (!Array.isArray(definitions)) throw new Error("customCsses must be an array");
  const ids = new Set();
  return definitions.map((definition, index) => {
    const label = `customCsses[${index}]`;
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      throw new Error(`${label} must be an object`);
    }
    if (typeof definition.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(definition.id)) {
      throw new Error(`${label}.id must contain only letters, numbers, underscores, and hyphens`);
    }
    if (ids.has(definition.id)) throw new Error(`Duplicate custom CSS id: ${definition.id}`);
    ids.add(definition.id);
    return { id: definition.id, css: stringValue(definition.css, `${label}.css`, "", { allowEmpty: true }) };
  });
}

function imageProcessingValue(definition, label) {
  const value = definition ?? {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}.imageProcessing must be an object`);
  }
  const mode = String(value.mode ?? "color").toLowerCase();
  if (!["color", "grayscale", "monochrome"].includes(mode)) {
    throw new Error(`${label}.imageProcessing.mode must be color, grayscale, or monochrome`);
  }
  const dither = String(value.dither ?? "none").toLowerCase();
  if (!["none", "floyd-steinberg", "atkinson"].includes(dither)) {
    throw new Error(`${label}.imageProcessing.dither must be none, floyd-steinberg, or atkinson`);
  }
  if (dither !== "none" && mode !== "monochrome") {
    throw new Error(`${label}.imageProcessing.dither requires monochrome mode`);
  }
  const palette = value.palette ?? [];
  if (!Array.isArray(palette) || palette.length > 0) {
    throw new Error(`${label}.imageProcessing.palette must be an empty array; custom palettes are not supported yet`);
  }
  const rotation = integerValue(value.rotation, `${label}.imageProcessing.rotation`, 0, { min: 0, max: 270 });
  if (![0, 90, 180, 270].includes(rotation)) {
    throw new Error(`${label}.imageProcessing.rotation must be 0, 90, 180, or 270`);
  }
  return {
    mode,
    palette: [],
    dither,
    threshold: integerValue(value.threshold, `${label}.imageProcessing.threshold`, 128, { min: 0, max: 255 }),
    invert: booleanValue(value.invert, `${label}.imageProcessing.invert`, false),
    rotation,
  };
}

function taskFromDefinition(definition, index, shared, customCssById) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw new Error(`tasks[${index}] must be an object`);
  }
  const label = `tasks[${index}]`;
  const id = definition.id;
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`${label}.id must contain only letters, numbers, underscores, and hyphens`);
  }
  const dashboardPath = definition.dashboardPath ?? "/lovelace/0";
  if (typeof dashboardPath !== "string" || dashboardPath.length === 0) {
    throw new Error(`${label}.dashboardPath must be a non-empty string`);
  }
  const format = String(definition.format ?? "png").toLowerCase();
  if (!["png", "jpeg"].includes(format)) throw new Error(`${label}.format must be png or jpeg`);
  const colorScheme = String(definition.colorScheme ?? "light").toLowerCase();
  if (!["light", "dark"].includes(colorScheme)) {
    throw new Error(`${label}.colorScheme must be light or dark`);
  }
  const outputFilename = `${id}.${format === "jpeg" ? "jpg" : "png"}`;
  const customCssIds = definition.customCssIds ?? [];
  if (!Array.isArray(customCssIds)) throw new Error(`${label}.customCssIds must be an array`);
  const selectedCssIds = customCssIds.map((id, cssIndex) => {
    if (typeof id !== "string" || !customCssById.has(id)) {
      throw new Error(`${label}.customCssIds[${cssIndex}] must reference an existing custom CSS`);
    }
    return id;
  });
  if (new Set(selectedCssIds).size !== selectedCssIds.length) {
    throw new Error(`${label}.customCssIds must not contain duplicates`);
  }
  const retryInitialDelaySeconds = integerValue(
    definition.retryInitialDelaySeconds,
    `${label}.retryInitialDelaySeconds`,
    2,
    { min: 0, max: 3600 },
  );
  const retryMaximumDelaySeconds = integerValue(
    definition.retryMaximumDelaySeconds,
    `${label}.retryMaximumDelaySeconds`,
    30,
    { min: 0, max: 3600 },
  );
  if (retryMaximumDelaySeconds < retryInitialDelaySeconds) {
    throw new Error(`${label}.retryMaximumDelaySeconds must be greater than or equal to ${label}.retryInitialDelaySeconds`);
  }
  return {
    id,
    dashboardPath,
    dashboardUrl: new URL(dashboardPath, shared.haUrl).toString(),
    width: integerValue(definition.width, `${label}.width`, 800, { min: 1, max: 10000 }),
    height: integerValue(definition.height, `${label}.height`, 480, { min: 1, max: 10000 }),
    zoom: numberValue(definition.zoom, `${label}.zoom`, 1, { min: 0.1, max: 5 }),
    format,
    jpegQuality: integerValue(definition.jpegQuality, `${label}.jpegQuality`, 85, { min: 1, max: 100 }),
    refreshIntervalSeconds: integerValue(definition.refreshIntervalSeconds, `${label}.refreshIntervalSeconds`, 300, { min: 0 }),
    retryAttempts: integerValue(definition.retryAttempts, `${label}.retryAttempts`, 2, { min: 0, max: 10 }),
    retryInitialDelaySeconds,
    retryMaximumDelaySeconds,
    navigationTimeoutMs: integerValue(definition.navigationTimeoutMs, `${label}.navigationTimeoutMs`, 60000, { min: 1000 }),
    waitAfterLoadMs: integerValue(definition.waitAfterLoadMs, `${label}.waitAfterLoadMs`, 3000, { min: 0 }),
    waitForSelector: stringValue(definition.waitForSelector, `${label}.waitForSelector`, "home-assistant"),
    customCss: stringValue(definition.customCss, `${label}.customCss`, "", { allowEmpty: true }),
    customCssFile: stringValue(definition.customCssFile, `${label}.customCssFile`, "", { allowEmpty: true }),
    customCssIds: selectedCssIds,
    reusableCustomCss: selectedCssIds.map((id) => customCssById.get(id)),
    colorScheme,
    timezone: timezoneValue(definition.timezone, `${label}.timezone`, shared.imageScheduleTimezone),
    hideCursor: booleanValue(definition.hideCursor, `${label}.hideCursor`, true),
    disableAnimations: booleanValue(definition.disableAnimations, `${label}.disableAnimations`, true),
    outputFilename,
    outputPath: path.join(shared.outputDirectory, outputFilename),
    imageProcessing: imageProcessingValue(definition.imageProcessing, label),
  };
}

export function normalizeTasks(definitions, shared, customCsses = []) {
  if (!Array.isArray(definitions)) throw new Error("tasks must be an array");
  const customCssById = new Map(customCsses.map((entry) => [entry.id, entry.css]));
  const tasks = definitions.map((definition, index) => taskFromDefinition(definition, index, shared, customCssById));
  const ids = new Set();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate screenshot task id: ${task.id}`);
    ids.add(task.id);
  }
  return tasks;
}

function minutes(value, name) {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`${name} must use 24-hour HH:MM format`);
  }
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function normalizedSlot(slot, imageIndex, slotIndex, taskById) {
  const label = `images[${imageIndex}].slots[${slotIndex}]`;
  if (!slot || typeof slot !== "object" || Array.isArray(slot)) throw new Error(`${label} must be an object`);
  if (!Array.isArray(slot.days) || slot.days.length === 0) throw new Error(`${label}.days must be a non-empty array`);
  const days = [...new Set(slot.days.map((day) => String(day).toLowerCase()))];
  if (days.some((day) => !DAYS.includes(day))) throw new Error(`${label}.days contains an invalid weekday`);
  const startMinute = minutes(slot.start, `${label}.start`);
  const endMinute = minutes(slot.end, `${label}.end`);
  if (startMinute === endMinute) throw new Error(`${label} must have a non-zero time range`);
  if (typeof slot.taskId !== "string" || !taskById.has(slot.taskId)) {
    throw new Error(`${label}.taskId must reference an existing task`);
  }
  return { days, start: slot.start, end: slot.end, taskId: slot.taskId };
}

function weeklySegments(slot) {
  const start = minutes(slot.start, "slot.start");
  const end = minutes(slot.end, "slot.end");
  const segments = [];
  for (const day of slot.days) {
    const dayStart = DAYS.indexOf(day) * 1440;
    const absoluteEnd = dayStart + end + (end < start ? 1440 : 0);
    const absoluteStart = dayStart + start;
    if (absoluteEnd <= 10080) segments.push([absoluteStart, absoluteEnd]);
    else {
      segments.push([absoluteStart, 10080]);
      segments.push([0, absoluteEnd - 10080]);
    }
  }
  return segments;
}

function validateNoOverlap(image, imageIndex) {
  const segments = image.slots.flatMap((slot, slotIndex) => (
    weeklySegments(slot).map(([start, end]) => ({ start, end, slotIndex }))
  )).sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    if (current.start < previous.end) {
      throw new Error(`images[${imageIndex}] has overlapping slots ${previous.slotIndex} and ${current.slotIndex}`);
    }
  }
}

export function normalizeImages(definitions = [], tasks) {
  if (!Array.isArray(definitions)) throw new Error("images must be an array");
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const ids = new Set();
  return definitions.map((definition, imageIndex) => {
    const label = `images[${imageIndex}]`;
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) throw new Error(`${label} must be an object`);
    const id = definition.id;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`${label}.id must contain only letters, numbers, underscores, and hyphens`);
    if (ids.has(id)) throw new Error(`Duplicate image id: ${id}`);
    ids.add(id);
    if (typeof definition.fallbackTaskId !== "string" || !taskById.has(definition.fallbackTaskId)) {
      throw new Error(`${label}.fallbackTaskId must reference an existing task`);
    }
    if (definition.slots !== undefined && !Array.isArray(definition.slots)) throw new Error(`${label}.slots must be an array`);
    const image = {
      id,
      fallbackTaskId: definition.fallbackTaskId,
      slots: (definition.slots || []).map((slot, slotIndex) => normalizedSlot(slot, imageIndex, slotIndex, taskById)),
    };
    const fallback = taskById.get(image.fallbackTaskId);
    for (const taskId of new Set(image.slots.map((slot) => slot.taskId))) {
      const task = taskById.get(taskId);
      if (task.width !== fallback.width || task.height !== fallback.height || task.format !== fallback.format) {
        throw new Error(`${label} task ${taskId} must match fallback task dimensions and format`);
      }
    }
    validateNoOverlap(image, imageIndex);
    return image;
  });
}

export function normalizeConfiguration(definition, shared, { settings: managedSettings } = {}) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw new Error("configuration file must contain an object");
  }
  const settings = normalizeSettings(managedSettings ?? definition.settings);
  const customCsses = normalizeCustomCsses(definition.customCsses ?? []);
  const tasks = normalizeTasks(definition.tasks, { ...shared, ...settings }, customCsses);
  if (tasks.length === 0) throw new Error("At least one screenshot task is required");
  const images = normalizeImages(definition.images ?? [], tasks);
  return { ...settings, customCsses, tasks, images };
}

export function taskToDefinition(task) {
  return {
    id: task.id, dashboardPath: task.dashboardPath, width: task.width, height: task.height,
    refreshIntervalSeconds: task.refreshIntervalSeconds,
    retryAttempts: task.retryAttempts, retryInitialDelaySeconds: task.retryInitialDelaySeconds,
    retryMaximumDelaySeconds: task.retryMaximumDelaySeconds,
    waitAfterLoadMs: task.waitAfterLoadMs,
    colorScheme: task.colorScheme, timezone: task.timezone, disableAnimations: task.disableAnimations,
    zoom: task.zoom, format: task.format, jpegQuality: task.jpegQuality,
    navigationTimeoutMs: task.navigationTimeoutMs, waitForSelector: task.waitForSelector,
    customCss: task.customCss, customCssFile: task.customCssFile, hideCursor: task.hideCursor,
    customCssIds: [...task.customCssIds],
    imageProcessing: { ...task.imageProcessing, palette: [...task.imageProcessing.palette] },
  };
}

export function imageToDefinition(image) {
  return { id: image.id, fallbackTaskId: image.fallbackTaskId, slots: image.slots.map((slot) => ({ ...slot, days: [...slot.days] })) };
}

export function configurationToDefinition(configuration, { includeSettings = true } = {}) {
  return {
    ...(includeSettings ? { settings: {
      haUrl: configuration.haUrl,
      accessToken: configuration.accessToken,
      imageScheduleTimezone: configuration.imageScheduleTimezone,
      configUsername: configuration.configUsername,
      configPassword: configuration.configPassword,
    } } : {}),
    customCsses: (configuration.customCsses ?? []).map((entry) => ({ ...entry })),
    tasks: configuration.tasks.map(taskToDefinition),
    images: configuration.images.map(imageToDefinition),
  };
}

export function loadConfig(runtimeOrEnv = process.env) {
  const isRuntime = runtimeOrEnv?.runtimeMode === "standalone" || runtimeOrEnv?.runtimeMode === "home_assistant_app";
  const runtime = isRuntime ? runtimeOrEnv : (() => {
    const outputDirectory = path.resolve(runtimeOrEnv.OUTPUT_DIRECTORY || "/data");
    return {
      runtimeMode: "standalone", outputDirectory,
      port: integerValue(runtimeOrEnv.PORT, "PORT", 3000, { min: 1, max: 65535 }),
      adminPort: null,
      ignoreHttpsErrors: booleanValue(runtimeOrEnv.IGNORE_HTTPS_ERRORS, "IGNORE_HTTPS_ERRORS", false),
      configFile: path.join(outputDirectory, "config.json"), settingsManagedExternally: false, publicBaseUrl: "",
    };
  })();
  fs.mkdirSync(runtime.outputDirectory, { recursive: true });
  const definition = loadDefinition(runtime.configFile, { createBootstrap: runtime.runtimeMode === "standalone" });
  const isEmptyBootstrap = definition === null || (Array.isArray(definition?.tasks) && definition.tasks.length === 0
    && Array.isArray(definition.images) && definition.images.length === 0
    && (!definition.settings || Object.keys(definition.settings).length === 0));
  const managedSettings = runtime.settingsManagedExternally ? {
    haUrl: runtime.haUrl,
    accessToken: runtime.accessToken,
    imageScheduleTimezone: runtime.imageScheduleTimezone,
    configUsername: "ingress",
    configPassword: "managed-by-supervisor",
  } : undefined;
  const normalized = isEmptyBootstrap
    ? {
      haUrl: managedSettings?.haUrl ?? "", accessToken: managedSettings?.accessToken ?? "",
      imageScheduleTimezone: managedSettings?.imageScheduleTimezone ?? "UTC",
      configUsername: managedSettings?.configUsername ?? "admin", configPassword: managedSettings?.configPassword ?? "",
      customCsses: [], tasks: [], images: [], configured: false,
    }
    : normalizeConfiguration(definition, runtime, { settings: managedSettings });
  return { ...runtime, ...normalized, configured: !isEmptyBootstrap };
}
