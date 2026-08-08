import fs from "node:fs";
import path from "node:path";

const MODES = new Set(["standalone", "home_assistant_app"]);
const LOG_LEVELS = new Set(["trace", "debug", "info", "notice", "warning", "error", "fatal"]);

function integerValue(raw, name, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

function booleanValue(raw, name, fallback) {
  if (raw === undefined || raw === "") return fallback;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
    if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  }
  throw new Error(`${name} must be true or false`);
}

function requiredString(raw, name) {
  if (typeof raw !== "string" || raw.length === 0) throw new Error(`${name} must be a non-empty string`);
  return raw;
}

function urlValue(raw, name, { optional = false } = {}) {
  if (optional && (raw === undefined || raw === "")) return "";
  let value;
  try { value = new URL(requiredString(raw, name)); } catch { throw new Error(`${name} must be a valid http or https URL`); }
  if (!["http:", "https:"].includes(value.protocol)) throw new Error(`${name} must use http or https`);
  return value.toString().replace(/\/$/, "");
}

function timezoneValue(raw, name) {
  const value = requiredString(raw ?? "UTC", name);
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); } catch { throw new Error(`${name} must be a valid IANA timezone such as Asia/Bangkok`); }
  return value;
}

function loadAppOptions(optionsFile) {
  let options;
  try {
    options = JSON.parse(fs.readFileSync(optionsFile, "utf8"));
  } catch (error) {
    throw new Error(`Home Assistant App options could not be loaded: ${error.message}`);
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Home Assistant App options must contain an object");
  }
  const logLevel = String(options.log_level ?? "info").toLowerCase();
  if (!LOG_LEVELS.has(logLevel)) throw new Error("log_level is invalid");
  return {
    haUrl: urlValue(options.ha_url, "ha_url"),
    accessToken: requiredString(options.ha_access_token, "ha_access_token"),
    imageScheduleTimezone: timezoneValue(options.image_schedule_timezone, "image_schedule_timezone"),
    ignoreHttpsErrors: booleanValue(options.ignore_https_errors, "ignore_https_errors", false),
    publicBaseUrl: urlValue(options.public_base_url, "public_base_url", { optional: true }),
    logLevel,
  };
}

export function loadRuntimeSettings({ env = process.env, optionsFile = "/data/options.json", dataDirectory = "/data" } = {}) {
  const runtimeMode = env.RUNTIME_MODE || "standalone";
  if (!MODES.has(runtimeMode)) {
    throw new Error("RUNTIME_MODE must be standalone or home_assistant_app");
  }
  if (runtimeMode === "standalone") {
    const outputDirectory = path.resolve(env.OUTPUT_DIRECTORY || "/data");
    return {
      runtimeMode,
      outputDirectory,
      configFile: path.join(outputDirectory, "config.json"),
      port: integerValue(env.PORT, "PORT", 3000),
      adminPort: null,
      ignoreHttpsErrors: booleanValue(env.IGNORE_HTTPS_ERRORS, "IGNORE_HTTPS_ERRORS", false),
      settingsManagedExternally: false,
      publicBaseUrl: "",
    };
  }

  const options = loadAppOptions(optionsFile);
  return {
    runtimeMode,
    outputDirectory: path.join(dataDirectory, "images"),
    configFile: path.join(dataDirectory, "config.json"),
    port: 3000,
    adminPort: 8099,
    settingsManagedExternally: true,
    ...options,
  };
}
