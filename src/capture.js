import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { captureDimensions, processImage } from "./image-processing.js";

export const FAILURE_CATEGORIES = Object.freeze({
  AUTHENTICATION: "authentication",
  NAVIGATION: "navigation",
  READINESS_TIMEOUT: "readiness_timeout",
  CUSTOM_CSS: "custom_css",
  SCREENSHOT_WRITE: "screenshot_write",
  BROWSER_UNAVAILABLE: "browser_unavailable",
  SHUTDOWN: "shutdown",
});

export class CaptureError extends Error {
  constructor(category, cause) {
    super(`Capture failed: ${category}`, { cause });
    this.name = "CaptureError";
    this.category = category;
  }
}

const closedBrowserPattern = /browser.*(?:closed|disconnected)|target (?:page, context or browser )?has been closed|connection closed/i;

export function captureFailure(error, fallback = FAILURE_CATEGORIES.NAVIGATION) {
  if (error instanceof CaptureError) return error;
  const category = closedBrowserPattern.test(String(error?.message || error))
    ? FAILURE_CATEGORIES.BROWSER_UNAVAILABLE
    : fallback;
  return new CaptureError(category, error);
}

export async function readCustomCss(task) {
  const fileCss = task.customCssFile ? await fs.readFile(task.customCssFile, "utf8") : "";
  const stabilityCss = [
    task.hideCursor ? "* { cursor: none !important; }" : "",
    task.disableAnimations
      ? "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }"
      : "",
  ].filter(Boolean).join("\n");
  return [stabilityCss, ...(task.reusableCustomCss ?? []), fileCss, task.customCss].filter(Boolean).join("\n");
}

async function injectCssIntoOpenShadowRoots(page, css) {
  if (!css) return;
  await page.evaluate((styleText) => {
    const marker = "ha-screenshot-custom-css";
    const visit = (root) => {
      if (!root.querySelector(`style[data-${marker}]`)) {
        const style = document.createElement("style");
        style.setAttribute(`data-${marker}`, "");
        style.textContent = styleText;
        const styleHost = root.nodeType === Node.DOCUMENT_NODE
          ? root.head || root.documentElement
          : root;
        styleHost.appendChild(style);
      }
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };
    visit(document);
  }, css);
}

export class DashboardCapture {
  constructor(config, logger = console, { launch = (options) => chromium.launch(options) } = {}) {
    this.config = config;
    this.logger = logger;
    this.browser = null;
    this.launch = launch;
    this.restartPromise = null;
    this.stopPromise = null;
    this.screenshotQueue = Promise.resolve();
    this.stopping = false;
    this.contexts = new Set();
  }

  queueScreenshot(page, options) {
    const screenshot = this.screenshotQueue.then(() => page.screenshot(options));
    this.screenshotQueue = screenshot.catch(() => {});
    return screenshot;
  }

  async start() {
    await fs.mkdir(this.config.outputDirectory, { recursive: true });
    this.stopping = false;
    await this.ensureBrowser();
  }

  browserIsAvailable(browser = this.browser) {
    return Boolean(browser && (typeof browser.isConnected !== "function" || browser.isConnected()));
  }

  async ensureBrowser(failedBrowser = null) {
    if (this.stopping) throw new CaptureError(FAILURE_CATEGORIES.SHUTDOWN);
    if (this.browserIsAvailable() && this.browser !== failedBrowser) return this.browser;
    if (!this.restartPromise) {
      this.restartPromise = (async () => {
        const previous = this.browser;
        this.browser = null;
        if (previous && this.browserIsAvailable(previous)) await previous.close().catch(() => {});
        if (this.stopping) throw new CaptureError(FAILURE_CATEGORIES.SHUTDOWN);
        const browser = await this.launch({ headless: true, args: ["--disable-lcd-text"] });
        if (this.stopping) {
          await browser.close().catch(() => {});
          throw new CaptureError(FAILURE_CATEGORIES.SHUTDOWN);
        }
        this.browser = browser;
        browser.on?.("disconnected", () => {
          if (this.browser === browser) this.browser = null;
        });
        return browser;
      })().catch((error) => { throw captureFailure(error, FAILURE_CATEGORIES.BROWSER_UNAVAILABLE); })
        .finally(() => { this.restartPromise = null; });
    }
    return this.restartPromise;
  }

  async capture(task) {
    if (this.stopping) throw new CaptureError(FAILURE_CATEGORIES.SHUTDOWN);
    const browser = await this.ensureBrowser();
    const captureSize = captureDimensions(task);
    let context;

    try {
      try {
        context = await browser.newContext({
          viewport: captureSize,
          deviceScaleFactor: 1,
          colorScheme: task.colorScheme,
          timezoneId: task.timezone,
          ignoreHTTPSErrors: this.config.ignoreHttpsErrors,
        });
        this.contexts.add(context);
      } catch (error) {
        throw captureFailure(error, FAILURE_CATEGORIES.BROWSER_UNAVAILABLE);
      }
      await context.addInitScript(({ token, hassUrl }) => {
        if (location.origin === new URL(hassUrl).origin) {
          localStorage.setItem("hassTokens", JSON.stringify({ hassUrl, access_token: token }));
        }
      }, { token: this.config.accessToken, hassUrl: this.config.haUrl });

      const page = await context.newPage();
      page.setDefaultTimeout(task.navigationTimeoutMs);
      page.setDefaultNavigationTimeout(task.navigationTimeoutMs);
      try {
        await page.goto(task.dashboardUrl, { waitUntil: "domcontentloaded" });
      } catch (error) {
        throw captureFailure(error, FAILURE_CATEGORIES.NAVIGATION);
      }

      if (new URL(page.url()).pathname.includes("/auth/")) {
        throw new CaptureError(FAILURE_CATEGORIES.AUTHENTICATION);
      }

      try {
        await page.waitForSelector(task.waitForSelector, { state: "attached" });
      } catch (error) {
        throw captureFailure(error, FAILURE_CATEGORIES.READINESS_TIMEOUT);
      }
      if (task.waitAfterLoadMs > 0) await page.waitForTimeout(task.waitAfterLoadMs);
      if (new URL(page.url()).pathname.includes("/auth/")) {
        throw new CaptureError(FAILURE_CATEGORIES.AUTHENTICATION);
      }

      try {
        await page.evaluate((zoom) => {
          document.documentElement.style.zoom = String(zoom);
        }, task.zoom);
        await injectCssIntoOpenShadowRoots(page, await readCustomCss(task));
        await page.evaluate(() => document.fonts?.ready);
      } catch (error) {
        throw captureFailure(error, FAILURE_CATEGORIES.CUSTOM_CSS);
      }

      const sourcePath = path.join(
        this.config.outputDirectory,
        `.${task.outputFilename}.${process.pid}.source.tmp`,
      );
      const processedPath = path.join(
        this.config.outputDirectory,
        `.${task.outputFilename}.${process.pid}.processed.tmp`,
      );
      const options = {
        path: sourcePath,
        type: task.format,
        animations: task.disableAnimations ? "disabled" : "allow",
        clip: { x: 0, y: 0, width: captureSize.width, height: captureSize.height },
      };
      if (task.format === "jpeg") options.quality = task.jpegQuality;
      try {
        try {
          await this.queueScreenshot(page, options);
          await processImage(sourcePath, processedPath, task);
          await fs.rename(processedPath, task.outputPath);
        } catch (error) {
          throw captureFailure(error, FAILURE_CATEGORIES.SCREENSHOT_WRITE);
        }
      } finally {
        await Promise.all([fs.rm(sourcePath, { force: true }), fs.rm(processedPath, { force: true })]);
      }
      return { path: task.outputPath, capturedAt: new Date() };
    } catch (error) {
      const failure = captureFailure(error);
      if (failure.category === FAILURE_CATEGORIES.BROWSER_UNAVAILABLE && !this.stopping) {
        await this.ensureBrowser(browser).catch(() => {});
      }
      throw this.stopping ? new CaptureError(FAILURE_CATEGORIES.SHUTDOWN, error) : failure;
    } finally {
      if (context) {
        this.contexts.delete(context);
        await context.close().catch(() => {});
      }
    }
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      await this.restartPromise?.catch(() => {});
      await Promise.all([...this.contexts].map((context) => context.close().catch(() => {})));
      this.contexts.clear();
      const browser = this.browser;
      this.browser = null;
      if (browser) await browser.close().catch(() => {});
    })();
    return this.stopPromise;
  }
}
