import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { z } from "zod";
import { HttpError } from "../shared/errors";
import { version } from "../shared/version";
import { createAgentRoutes, createAgentService } from "./agents";
import { createHyperframesApi } from "./hyperframes/api";
import { createMcpHttpHandler } from "./mcp/server";
import { createReviewService } from "./projects/review";
import { createProjectRoutes } from "./projects/routes";
import { createProjectStore } from "./projects/store";
import { createWorkspaceRoutes } from "./workspace";
import { createTranscriptService } from "./transcript/service";

export async function createApp(
  options: {
    dataDir?: string;
    projectsDir?: string;
    port?: number;
    staticDir?: string;
    allowDevOrigin?: boolean;
  } = {},
) {
  process.env.HYPERFRAMES_NO_TELEMETRY = "1";
  process.env.DO_NOT_TRACK = "1";
  const dataDir = resolve(
    options.dataDir ??
      process.env.CUTROOM_DATA_DIR ??
      join(homedir(), ".local", "share", "cutroom"),
  );
  const projectsDir = resolve(
    options.projectsDir ??
      process.env.CUTROOM_PROJECTS_DIR ??
      join(homedir(), "Videos", "Cutroom"),
  );
  const port = options.port ?? Number(process.env.CUTROOM_PORT || 4317);
  const baseUrl = `http://127.0.0.1:${port}`;
  const projects = await createProjectStore({ dataDir, projectsDir });
  const review = createReviewService(projects);
  const agents = await createAgentService({
    projects,
    review,
    dataDir,
    studioUrl: baseUrl,
  });
  const editor = createHyperframesApi(projects);
  const transcripts = createTranscriptService(projects);
  const app = new Hono();
  let closing = false;
  let shutdown: Promise<void> | undefined;
  app.use("*", async (c, next) => {
    if (closing)
      return c.json(
        { error: "Cutroom is closing. Reopen the app to continue." },
        503,
      );
    const url = new URL(c.req.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      return c.json({ error: "Cutroom accepts local connections only." }, 403);
    const origin = c.req.header("origin");
    const allowed = [baseUrl, `http://localhost:${port}`];
    if (options.allowDevOrigin)
      allowed.push("http://127.0.0.1:5173", "http://localhost:5173");
    if (origin && !allowed.includes(origin))
      return c.json(
        { error: "This origin cannot access your local workspace." },
        403,
      );
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof HttpError)
      return c.json({ error: error.message }, error.status);
    if (error instanceof z.ZodError)
      return c.json(
        { error: error.issues.map((issue) => issue.message).join(" ") },
        400,
      );
    if (error instanceof SyntaxError)
      return c.json({ error: "The request body is not valid JSON." }, 400);
    console.error(error);
    return c.json({ error: error.message }, 500);
  });
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const mcpCommand = [
    ...(port === 4317 ? [] : ["env", `CUTROOM_URL=${baseUrl}`]),
    process.execPath,
    join(root, "src/server/mcp/stdio.ts"),
  ]
    .map((argument) => `'${argument.replaceAll("'", "'\\''")}'`)
    .join(" ");
  app.route(
    "/api/cutroom",
    createWorkspaceRoutes({ projects, dataDir, projectsDir, mcpCommand }),
  );
  app.route("/api/cutroom", createProjectRoutes(projects, transcripts, review));
  app.route("/api/cutroom", createAgentRoutes(agents));
  app.route("/api", editor);
  const mcp = createMcpHttpHandler({ baseUrl });
  app.all("/mcp", (c) => mcp(c.req.raw));
  app.get("/health", (c) => c.json({ ok: true, app: "cutroom", version }));
  app.all("/api/*", (c) =>
    c.json({ error: "This API route does not exist." }, 404),
  );
  const staticDir = options.staticDir ?? resolve(root, "dist");
  app.get("*", serveStatic({ root: staticDir }));
  app.get("*", serveStatic({ root: staticDir, path: "index.html" }));
  return {
    app,
    projects,
    agents,
    editor,
    dispose() {
      closing = true;
      return (shutdown ??= (async () => {
        const failures: unknown[] = [];
        for (const cleanup of [
          () => agents.dispose(),
          () => transcripts.dispose(),
          () => editor.dispose(),
          () => projects.close(),
        ]) {
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length)
          throw new AggregateError(
            failures,
            "Cutroom could not finish closing every service.",
          );
      })());
    },
  };
}
