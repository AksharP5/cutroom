// Preview capture follows the Apache-2.0 HyperFrames Studio vite.browser.ts and vite.thumbnail.ts.
// https://github.com/heygen-com/hyperframes/tree/v0.9.26/packages/studio
import {
  getElementScreenshotClip,
  thumbnailDeviceScaleFactor,
} from "@hyperframes/studio-server";
import type { StudioApiAdapter } from "@hyperframes/studio-server";
import type { Browser, Page } from "puppeteer-core";
import { browserExecutable, studioRenderScripts } from "./render";

type ThumbnailOptions = Parameters<
  NonNullable<StudioApiAdapter["generateThumbnail"]>
>[0];

interface PreviewWindow extends Window {
  __player?: { seek?: (time: number) => void };
  __timelines?: Record<string, { pause?: (time?: number) => void }>;
  __hfWaitForSeekCompletion?: () => Promise<void>;
  __hfStudioManualEditsApply?: () => number;
  __hfStudioMotionApply?: () => number;
  gsap?: { ticker?: { tick?: () => void } };
}

/** One browser is reused; individual captures own isolated, cancellable pages. */
export function createThumbnailRenderer() {
  let browser: Promise<Browser> | undefined;
  let closing: Promise<void> | undefined;
  const getBrowser = () =>
    (browser ??= (async () => {
      const executablePath = browserExecutable();
      if (!executablePath)
        throw new Error(
          "Chromium is required for frame captures. Install Chromium or set HYPERFRAMES_BROWSER_PATH.",
        );
      const { default: puppeteer } = await import("puppeteer-core");
      const instance = await puppeteer.launch({
        headless: true,
        executablePath,
        args: [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--mute-audio",
          "--autoplay-policy=no-user-gesture-required",
          "--use-gl=angle",
          "--use-angle=swiftshader",
          "--enable-unsafe-swiftshader",
        ],
      });
      instance.on("disconnected", () => {
        browser = undefined;
      });
      return instance;
    })().catch((error: unknown) => {
      browser = undefined;
      throw error;
    }));

  return {
    async capture(options: ThumbnailOptions): Promise<Buffer | null> {
      if (closing || options.signal.aborted) return null;
      let page: Page | undefined;
      const abort = () => {
        void page?.close().catch(() => {});
      };
      options.signal.addEventListener("abort", abort, { once: true });
      try {
        const instance = await getBrowser();
        if (closing || options.signal.aborted) return null;
        page = await instance.newPage();
        await page.setViewport({
          width: options.width,
          height: options.height,
          deviceScaleFactor: thumbnailDeviceScaleFactor(options),
        });
        await page.goto(options.previewUrl, {
          waitUntil: "networkidle0",
          timeout: 20_000,
        });
        await page.evaluate(async (time: number) => {
          const preview = window as PreviewWindow;
          document.body.style.margin = "0";
          document.body.style.overflow = "hidden";
          document.querySelectorAll("audio,video").forEach((media) => {
            if (media instanceof HTMLMediaElement) media.muted = true;
          });
          if (typeof preview.__player?.seek === "function")
            preview.__player.seek(time);
          else
            for (const timeline of Object.values(preview.__timelines ?? {}))
              timeline.pause?.(time);
          preview.gsap?.ticker?.tick?.();
          await preview.__hfWaitForSeekCompletion?.();
          await document.fonts.ready;
        }, options.seekTime);
        for (const content of await studioRenderScripts(
          options.project.dir,
          options.compPath,
        ))
          await page.addScriptTag({ content });
        await page.evaluate(async () => {
          const preview = window as PreviewWindow;
          await new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          );
          preview.__hfStudioManualEditsApply?.();
          preview.__hfStudioMotionApply?.();
        });
        const clip = options.selector
          ? await page.evaluate(
              getElementScreenshotClip,
              options.selector,
              options.selectorIndex,
            )
          : undefined;
        if (closing || options.signal.aborted) return null;
        const image = await page.screenshot(
          options.format === "png"
            ? { type: "png", ...(clip ? { clip } : {}) }
            : { type: "jpeg", quality: 80, ...(clip ? { clip } : {}) },
        );
        return Buffer.from(image);
      } catch (error) {
        if (closing || options.signal.aborted) return null;
        throw error;
      } finally {
        options.signal.removeEventListener("abort", abort);
        await page?.close().catch(() => {});
      }
    },
    close() {
      closing ??= (async () => {
        const current = browser;
        if (current) await (await current).close();
      })();
      return closing;
    },
  };
}
