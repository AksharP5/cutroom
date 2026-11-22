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
import { createMediaImportRoutes } from "./projects/mediaImportRoutes";
import { sweepMediaImports } from "./projects/mediaImport";
import { createDuplicateRoutes, sweepDuplicates } from "./projects/duplicate";
import type { Project } from "../shared/project";
import { createProjectStore, trackCommittedEntry } from "./projects/store";
import { EDIT_HISTORY_HEADER } from "../shared/timeline/schema";
import { createTimelineRoutes } from "./timeline/routes";
import { createCaptionRoutes } from "./captions/routes";
import { createWorkspaceRoutes } from "./workspace";
import { createVariableRoutes } from "./projects/variables";
import { createMotionRoutes } from "./projects/motion";
import { createLayerTextRoutes } from "./projects/layerText";
import { createTranscriptService } from "./transcript/service";
import { createMediaRoutes } from "./media/routes";
import { createFontRoutes } from "./fonts/routes";
import { createGradeRoutes } from "./grade/routes";
import { createLibrary } from "./library/registry";
import { createLibraryPreviews } from "./library/preview";
import { createLibraryRoutes } from "./library/routes";
import { allowsLocalRequest } from "./localAccess";

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
  const listed = await projects.list();
  await Promise.all(listed.map(sweepMediaImports));
  await sweepDuplicates([
    projects.projectsDir,
    ...listed.map(({ path }) => dirname(path)),
  ]);
  const review = createReviewService(projects);
  const mediaImport = createMediaImportRoutes(projects, review);
  const agents = await createAgentService({
    projects,
    review,
    dataDir,
    studioUrl: baseUrl,
  });
  const media = createMediaRoutes(projects);
  const editor = createHyperframesApi(projects, review, media.media);
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
    if (!allowsLocalRequest(c.req.raw, baseUrl, options.allowDevOrigin))
      return c.json(
        {
          error:
            "This request cannot access your local workspace. Mutations require Cutroom's Origin header.",
        },
        403,
      );
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    // Restricts self-navigation by sandboxed preview frames as well as their initial load.
    if (!new URL(c.req.url).pathname.startsWith("/api/"))
      c.header(
        "content-security-policy",
        "frame-src 'self'; object-src 'none'",
      );
    await next();
  });
  app.use("/api/*", async (c, next) => {
    const entryId = await trackCommittedEntry(next);
    if (entryId && !c.res.headers.has(EDIT_HISTORY_HEADER))
      c.header(EDIT_HISTORY_HEADER, entryId);
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
    "env",
    `CUTROOM_DATA_DIR=${dataDir}`,
    ...(port === 4317 ? [] : [`CUTROOM_URL=${baseUrl}`]),
    process.execPath,
    join(root, "src/server/mcp/stdio.ts"),
  ]
    .map((argument) => `'${argument.replaceAll("'", "'\\''")}'`)
    .join(" ");
  /** Work in a project that must finish before it can leave the list or be copied. */
  const busy = (project: Project, then: string, caller?: "agent") => {
    if (editor.runningExport(project.id))
      return `"${project.name}" is exporting. Wait for the export to finish or cancel it, then ${then}.`;
    // The agent asking is waiting on this request, so it is not writing.
    if (caller === "agent") return;
    const working = agents
      .list(project.id)
      .find(
        (session) =>
          session.status === "running" || session.status === "waiting",
      );
    if (working)
      return `An agent is working in "${project.name}" (${working.title}). Stop it or wait for it to finish, then ${then}.`;
  };
  const duplicates = createDuplicateRoutes(
    projects,
    review,
    (project, native) =>
      busy(project, "duplicate it", native ? "agent" : undefined),
  );
  const timeline = createTimelineRoutes(projects, review);
  const variables = createVariableRoutes(projects, review);
  app.route(
    "/api/cutroom",
    createWorkspaceRoutes({
      projects,
      review,
      dataDir,
      projectsDir,
      mcpCommand,
      subscribePreview: editor.subscribe,
      subscribeAnimationFeedback: timeline.subscribeAnimationFeedback,
      subscribeExports: editor.subscribeExports,
      subscribeVariables: variables.subscribe,
    }),
  );
  app.route(
    "/api/cutroom",
    createProjectRoutes(
      projects,
      review,
      transcripts,
      media.media.proxyState,
      timeline.timelineSnapshot,
      (project) => busy(project, "remove the project"),
      (project) => editor.runningExport(project.id)?.composition,
    ),
  );
  app.route("/api/cutroom", duplicates.api);
  app.route("/api/cutroom", timeline);
  app.route("/api/cutroom", variables);
  app.route("/api/cutroom", createMotionRoutes(projects, review));
  app.route("/api/cutroom", createLayerTextRoutes(projects, review));
  app.route(
    "/api/cutroom",
    createCaptionRoutes(projects, review, transcripts, timeline.editInWindow),
  );
  app.route("/api/cutroom", createFontRoutes(projects, review));
  app.route("/api/cutroom", createGradeRoutes(projects, review));
  const library = createLibrary({ dataDir });
  app.route(
    "/api/cutroom",
    createLibraryRoutes(projects, review, library, timeline),
  );
  // Before the project previews, which answer every other /api/isolated/ key.
  app.route("/api", createLibraryPreviews(library));
  app.route("/api/cutroom", createAgentRoutes(agents));
  app.route("/api/cutroom", media);
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
    dataDir,
    projects,
    agents,
    review,
    editor,
    mediaImport,
    dispose() {
      closing = true;
      return (shutdown ??= (async () => {
        const failures: unknown[] = [];
        for (const cleanup of [
          () => mediaImport.dispose(),
          () => duplicates.dispose(),
          () => agents.dispose(),
          () => transcripts.dispose(),
          () => mcp.dispose(),
          () => editor.dispose(),
          () => media.dispose(),
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
