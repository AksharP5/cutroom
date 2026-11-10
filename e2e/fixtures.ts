import { test as base } from "@playwright/test";

/** API test setup is a native client; browser Origin headers remain browser-owned. */
export const test = base.extend({
  request: async ({ playwright, baseURL }, use) => {
    const request = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { origin: new URL(baseURL!).origin },
    });
    try {
      await use(request);
    } finally {
      await request.dispose();
    }
  },
});
export { expect } from "@playwright/test";
