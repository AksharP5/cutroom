import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { previewPolicy } from "./isolation.ts";

function replaceOnce(
  source: string,
  before: string,
  after: string,
  file: string,
) {
  if (source.split(before).length !== 2)
    throw new Error(
      `Cutroom's render isolation no longer matches ${file}. Review the HyperFrames upgrade before exporting.`,
    );
  return source.replace(before, after);
}

/** Version-checked host changes, like studioPlugin. No dependency files are modified. */
export function registerRenderIsolation() {
  for (const name of ["producer", "engine"]) {
    const manifest: unknown = JSON.parse(
      readFileSync(
        new URL("../package.json", import.meta.resolve(`@hyperframes/${name}`)),
        "utf8",
      ),
    );
    if (
      !manifest ||
      typeof manifest !== "object" ||
      !("version" in manifest) ||
      manifest.version !== "0.9.26"
    )
      throw new Error(
        `Cutroom's render isolation requires @hyperframes/${name} 0.9.26.`,
      );
  }
  const isolation = JSON.stringify(
    new URL("./isolation.ts", import.meta.url).href,
  );
  const projectPaths = JSON.stringify(
    new URL("../projects/path.ts", import.meta.url).href,
  );
  const httpErrors = JSON.stringify(
    new URL("../../shared/errors.ts", import.meta.url).href,
  );
  let producerLoaded = false;
  let captureLoaded = false;
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (
        !url.endsWith("/@hyperframes/producer/dist/index.js") &&
        !url.endsWith("/@hyperframes/engine/dist/services/frameCapture.js")
      )
        return loaded;
      let source = String(loaded.source);
      if (url.endsWith("/producer/dist/index.js")) {
        source = `import { projectPath } from ${projectPaths};\nimport { HttpError } from ${httpErrors};\n${source}`;
        source = replaceOnce(
          source,
          "function createFileServer(options) {",
          `function createFileServer(options) {\n  const cutroomPolicy = ${previewPolicy.toString()};`,
          url,
        );
        source = replaceOnce(
          source,
          "      const candidate = join(root, relativePath);\n      if (isPathInside(candidate, root)) file = openRegularFile(candidate);",
          `      try {
        const candidate = await projectPath({ path: root }, relativePath);
        file = openRegularFile(candidate);
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) continue;
        if (error instanceof HttpError) return c.text(error.message, error.status);
        throw error;
      }`,
          url,
        );
        source = replaceOnce(
          source,
          '  app.get("/*", async (c) => {',
          `  app.use("*", async (c, next) => {
    await next();
    c.header("Content-Security-Policy", cutroomPolicy(new URL(c.req.url).origin + "/"));
    c.header("Connection-Allowlist", "(" + JSON.stringify(new URL(c.req.url).origin + "/*") + ")");
    c.header("X-DNS-Prefetch-Control", "off");
    c.header("Access-Control-Allow-Origin", "null");
    c.header("X-Content-Type-Options", "nosniff");
  });
  app.get("/*", async (c) => {`,
          url,
        );
        source = replaceOnce(
          source,
          "      const ext = extname(filePath).toLowerCase();",
          "      const ext = extname(relativePath).toLowerCase();",
          url,
        );
        producerLoaded = true;
      } else {
        source = `import { isolateCapturePage as cutroomIsolatePage } from ${isolation};\n${source}`;
        source = replaceOnce(
          source,
          "    const page = await browser.newPage();\n    onPageCreated(page);",
          "    const page = await browser.newPage();\n    onPageCreated(page);\n    await cutroomIsolatePage(page, serverUrl + '/');",
          url,
        );
        source = replaceOnce(
          source,
          "    const page = await session.browser.newPage();",
          "    const page = await session.browser.newPage();\n    await cutroomIsolatePage(page, session.serverUrl + '/');",
          url,
        );
        captureLoaded = true;
      }
      return { ...loaded, source };
    },
  });
  return () => {
    if (!producerLoaded || !captureLoaded)
      throw new Error(
        "The HyperFrames render isolation hooks did not load. Export was refused.",
      );
  };
}
