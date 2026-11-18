// Preview capture follows the Apache-2.0 HyperFrames Studio vite.browser.ts and vite.thumbnail.ts.
// https://github.com/heygen-com/hyperframes/tree/v0.9.26/packages/studio
import {
  createProjectSignatureAsync,
  getElementScreenshotClip,
  thumbnailDeviceScaleFactor,
} from "@hyperframes/studio-server";
import type { StudioApiAdapter } from "@hyperframes/studio-server";
import type { DiagnosticWindow } from "./diagnostics";
import type { Page } from "puppeteer-core";
import { studioRenderScripts } from "./render";
import { isolateCapturePage } from "./isolation";
import { launchCaptureBrowser } from "./captureBrowser";

// Change this when old cached renderer output should be invalidated.
export const thumbnailRendererVersion = "capture-provenance-v4";

type ThumbnailOptions = Parameters<
  NonNullable<StudioApiAdapter["generateThumbnail"]>
>[0];

interface PreviewWindow extends DiagnosticWindow {
  __cutroomSeekFrame?: (time: number) => Promise<void>;
  __renderReady?: boolean;
  __hfStartupError?: string;
  __hfStudioManualEditsApply?: () => number;
  __hfStudioMotionApply?: () => number;
}

/** Long enough to cover an agent's burst of frame checks, short enough to free the page's decoders. */
const idlePageTimeout = 30_000;

/** A loaded composition page and the project signature its compiled preview was built from. */
interface LoadedPage {
  page: Page;
  previewUrl: string;
  viewport: string;
  signature: string;
}

/**
 * One browser is reused; each capture owns an isolated, cancellable page. The last
 * successful page stays loaded so the next frame only seeks, but it is reused only
 * while the project on disk still has the signature its preview was compiled from.
 */
export function createThumbnailRenderer() {
  let browser: ReturnType<typeof launchCaptureBrowser> | undefined;
  let closing: Promise<void> | undefined;
  let idle:
    { loaded: LoadedPage; timer: ReturnType<typeof setTimeout> } | undefined;
  const takeIdle = () => {
    const current = idle;
    if (!current) return undefined;
    clearTimeout(current.timer);
    idle = undefined;
    return current.loaded;
  };
  // At most one page is kept, so memory stays at one loaded composition.
  const keepIdle = (loaded: LoadedPage) => {
    void takeIdle()
      ?.page.close()
      .catch(() => {});
    const timer = setTimeout(() => {
      if (idle?.loaded === loaded)
        void takeIdle()
          ?.page.close()
          .catch(() => {});
    }, idlePageTimeout);
    timer.unref();
    idle = { loaded, timer };
  };
  const getBrowser = () =>
    (browser ??= (async () => {
      const instance = await launchCaptureBrowser();
      void instance.closed
        .finally(() => {
          browser = undefined;
          takeIdle();
        })
        .catch((error: unknown) =>
          console.error("Capture cleanup failed:", error),
        );
      return instance;
    })().catch((error: unknown) => {
      browser = undefined;
      throw error;
    }));

  return {
    async capture(options: ThumbnailOptions): Promise<Buffer | null> {
      if (closing || options.signal.aborted) return null;
      const viewport = JSON.stringify([
        options.width,
        options.height,
        thumbnailDeviceScaleFactor(options),
      ]);
      let page: Page | undefined;
      let loaded: LoadedPage | undefined;
      const abort = () => {
        void page?.close().catch(() => {});
      };
      options.signal.addEventListener("abort", abort, { once: true });
      try {
        // Take the idle page before any await so concurrent captures never share it.
        const candidate = takeIdle();
        if (candidate) {
          page = candidate.page;
          const reusable =
            candidate.previewUrl === options.previewUrl &&
            candidate.viewport === viewport &&
            candidate.signature ===
              (await createProjectSignatureAsync(options.project.dir));
          if (reusable) loaded = candidate;
          else {
            page = undefined;
            await candidate.page.close().catch(() => {});
          }
        }
        if (closing || options.signal.aborted) return null;
        if (!page) {
          const { browser: instance } = await getBrowser();
          if (closing || options.signal.aborted) return null;
          // Headless tabs share one window and pause animation frames in all but the newest,
          // so a kept page and a concurrent capture each need their own window.
          page = await instance.newPage({ type: "window" });
          const assets = new URL(options.previewUrl);
          const prefix = assets.pathname.match(
            /^\/api\/isolated\/[\w-]+\//,
          )?.[0];
          if (!prefix)
            throw new Error("Frame capture requires an isolated preview URL.");
          assets.pathname = prefix;
          await isolateCapturePage(page, assets.href);
          await page.setViewport({
            width: options.width,
            height: options.height,
            deviceScaleFactor: thumbnailDeviceScaleFactor(options),
          });
          await page.goto(options.previewUrl, {
            // Seek, fonts, and paint below own visual readiness. Background requests
            // must not hold this capture and every note behind it in the shared queue.
            waitUntil: "load",
            timeout: 20_000,
          });
        }
        const signature = await page.evaluate(
          async (time: number, composition: string) => {
            const preview = window as PreviewWindow;
            // Load can precede authored scripts, sub-compositions, and buildReady.
            // Ready scenes avoid a separate polling/protocol setup altogether.
            const ready = () =>
              Boolean(preview.__cutroomReadDiagnostics?.().length) ||
              typeof preview.__hfStartupError === "string" ||
              (preview.__renderReady === true &&
                typeof preview.__cutroomSeekFrame === "function");
            if (!ready()) {
              await new Promise<void>((resolve, reject) => {
                let frame = 0;
                const timeout = setTimeout(() => {
                  cancelAnimationFrame(frame);
                  reject(
                    new Error(
                      `HyperFrames readiness for "${composition}" did not complete within 20 s.`,
                    ),
                  );
                }, 20_000);
                const check = () => {
                  if (!ready()) {
                    frame = requestAnimationFrame(check);
                    return;
                  }
                  clearTimeout(timeout);
                  resolve();
                };
                frame = requestAnimationFrame(check);
              });
            }
            const diagnostics = preview.__cutroomReadDiagnostics?.() ?? [];
            if (diagnostics.length)
              throw new Error(
                diagnostics
                  .map(({ file, message }) => `${file}: ${message}`)
                  .join("\n"),
              );
            if (typeof preview.__hfStartupError === "string")
              throw new Error(preview.__hfStartupError);
            document.body.style.margin = "0";
            document.body.style.overflow = "hidden";
            document.querySelectorAll("audio,video").forEach((media) => {
              if (media instanceof HTMLMediaElement) media.muted = true;
            });
            await preview.__cutroomSeekFrame?.(time);
            await document.fonts.ready;
            // The preview route stamps the signature it compiled this document from.
            return document
              .querySelector('meta[name="hyperframes-project-signature"]')
              ?.getAttribute("content");
          },
          options.seekTime,
          options.compPath,
        );
        // The render scripts wrap seeking and expose re-apply hooks, so a loaded page keeps them.
        if (!loaded)
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
          const diagnostics = preview.__cutroomReadDiagnostics?.() ?? [];
          if (diagnostics.length)
            throw new Error(
              diagnostics
                .map(({ file, message }) => `${file}: ${message}`)
                .join("\n"),
            );
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
        // The route stamps the signature before the compiler reads the files, so an edit
        // landing mid-build leaves a stale stamp. Keep the page only if the files still match it.
        loaded ??=
          signature &&
          signature === (await createProjectSignatureAsync(options.project.dir))
            ? { page, previewUrl: options.previewUrl, viewport, signature }
            : undefined;
        return Buffer.from(image);
      } catch (error) {
        loaded = undefined;
        if (closing || options.signal.aborted) return null;
        throw error;
      } finally {
        options.signal.removeEventListener("abort", abort);
        // Failures, diagnostics, and cancellation discard the page instead of keeping it.
        if (loaded && !closing && !options.signal.aborted) keepIdle(loaded);
        else await page?.close().catch(() => {});
      }
    },
    close() {
      closing ??= (async () => {
        await takeIdle()
          ?.page.close()
          .catch(() => {});
        const current = browser;
        if (current) await (await current).close();
      })();
      return closing;
    },
  };
}
