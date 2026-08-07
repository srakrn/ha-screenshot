import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { captureDimensions, processImage } from "./image-processing.js";

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
  constructor(config, logger = console) {
    this.config = config;
    this.logger = logger;
    this.browser = null;
  }

  async start() {
    await fs.mkdir(this.config.outputDirectory, { recursive: true });
    this.browser = await chromium.launch({ headless: true });
  }

  async capture(task) {
    if (!this.browser) throw new Error("Browser is not started");
    const captureSize = captureDimensions(task);
    const context = await this.browser.newContext({
      viewport: captureSize,
      deviceScaleFactor: 1,
      colorScheme: task.colorScheme,
      timezoneId: task.timezone,
      ignoreHTTPSErrors: this.config.ignoreHttpsErrors,
    });

    try {
      await context.addInitScript(({ token, hassUrl }) => {
        if (location.origin === new URL(hassUrl).origin) {
          localStorage.setItem("hassTokens", JSON.stringify({ hassUrl, access_token: token }));
        }
      }, { token: this.config.accessToken, hassUrl: this.config.haUrl });

      const page = await context.newPage();
      page.setDefaultTimeout(task.navigationTimeoutMs);
      page.setDefaultNavigationTimeout(task.navigationTimeoutMs);
      await page.goto(task.dashboardUrl, { waitUntil: "domcontentloaded" });

      if (new URL(page.url()).pathname.includes("/auth/")) {
        throw new Error("Home Assistant showed the login page; check the URL and access token in Settings");
      }

      await page.waitForSelector(task.waitForSelector, { state: "attached" });
      if (task.waitAfterLoadMs > 0) await page.waitForTimeout(task.waitAfterLoadMs);
      if (new URL(page.url()).pathname.includes("/auth/")) {
        throw new Error("Home Assistant showed the login page; check the URL and access token in Settings");
      }

      await page.evaluate((zoom) => {
        document.documentElement.style.zoom = String(zoom);
      }, task.zoom);
      await injectCssIntoOpenShadowRoots(page, await readCustomCss(task));
      await page.evaluate(() => document.fonts?.ready);

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
        await page.screenshot(options);
        await processImage(sourcePath, processedPath, task);
        await fs.rename(processedPath, task.outputPath);
      } finally {
        await Promise.all([fs.rm(sourcePath, { force: true }), fs.rm(processedPath, { force: true })]);
      }
      return { path: task.outputPath, capturedAt: new Date() };
    } finally {
      await context.close();
    }
  }

  async stop() {
    await this.browser?.close();
    this.browser = null;
  }
}
