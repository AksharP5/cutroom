import { test as base } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { addStarterClips } from "../tests/starter-clips";

/** API test setup is a native client; browser Origin headers remain browser-owned. */
export const test = base.extend({
  request: async ({ playwright, baseURL }, use) => {
    const request = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { origin: new URL(baseURL!).origin },
    });
    // These tests were written when every new project started with three text clips on V1 to
    // V3. A project made through this API still gets them, before anything else reads it.
    const post = request.post.bind(request);
    request.post = async (url, options) => {
      const response = await post(url, options);
      if (url === "/api/cutroom/projects" && response.ok())
        await addStarterClips(ProjectSchema.parse(await response.json()));
      return response;
    };
    try {
      await use(request);
    } finally {
      await request.dispose();
    }
  },
});
export { expect } from "@playwright/test";
