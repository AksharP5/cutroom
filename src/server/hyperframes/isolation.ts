import type { Page } from "puppeteer-core";

/** Explicit asset URLs also work when sandboxing gives the document an opaque origin. */
export function previewPolicy(assets: string) {
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${assets}`,
    `style-src 'unsafe-inline' ${assets}`,
    `img-src data: blob: ${assets}`,
    `media-src data: blob: ${assets}`,
    `font-src data: ${assets}`,
    `connect-src ${assets}`,
    `base-uri ${assets}`,
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "worker-src 'none'",
  ].join("; ");
}

/** Headless pages also block navigation, redirects, and requests made outside CSP fetch directives. */
export async function isolateCapturePage(page: Page, assets: string) {
  const base = new URL(assets);
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.isInterceptResolutionHandled()) return;
    const url = new URL(request.url());
    const allowed =
      (url.origin === base.origin &&
        url.pathname.startsWith(base.pathname) &&
        ["GET", "HEAD"].includes(request.method())) ||
      (!request.isNavigationRequest() &&
        ["data:", "blob:"].includes(url.protocol));
    void (allowed ? request.continue() : request.abort("blockedbyclient"));
  });
}
