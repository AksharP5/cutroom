import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSocket } from "node:dgram";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { ProjectDocumentSchema } from "../src/shared/project";
import { createAgentRoutes } from "../src/server/agents/routes";
import { createAgentService } from "../src/server/agents/service";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { browserExecutable } from "../src/server/hyperframes/render";
import { allowsLocalRequest } from "../src/server/localAccess";
import { createMcpHttpHandler } from "../src/server/mcp/server";
import { createReviewService } from "../src/server/projects/review";
import { createProjectRoutes } from "../src/server/projects/routes";
import { createProjectStore } from "../src/server/projects/store";
import { createTimelineRoutes } from "../src/server/timeline/routes";

test.skipIf(!browserExecutable() || !Bun.which("ffmpeg"))(
  "isolated previews, timeline_view, thumbnails, and exports cannot annotate, approve, read projects, or send external requests",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cutroom-isolation-"));
    const projects = await createProjectStore({
      dataDir: root,
      projectsDir: join(root, "projects"),
    });
    const review = createReviewService(projects);
    const agents = await createAgentService({
      projects,
      review,
      dataDir: root,
      runtimeFactory: {
        capabilities: async (provider) => ({
          provider,
          available: true,
          skills: [],
          models: [],
          mcpServers: [],
        }),
        create: (_provider, options) => ({
          send: async () => {
            await options.request({
              id: "approval",
              kind: "approval",
              title: "Allow editing?",
              tool: "Write",
              input: {},
            });
          },
          interrupt: async () => {},
          dispose() {},
        }),
        dispose() {},
      },
    });
    const editor = createHyperframesApi(projects, review);
    const app = new Hono();
    let baseUrl = "";
    app.use("*", async (c, next) => {
      if (!allowsLocalRequest(c.req.raw, baseUrl)) return c.body(null, 403);
      await next();
    });
    app.route("/api/cutroom", createProjectRoutes(projects, review));
    app.route("/api/cutroom", createTimelineRoutes(projects, review));
    app.route("/api/cutroom", createAgentRoutes(agents));
    app.route("/api", editor);
    app.get("/host/:id", (c) =>
      c.html(
        `<iframe sandbox="allow-scripts" src="/api/projects/${c.req.param("id")}/isolated-preview"></iframe>`,
        200,
        { "Content-Security-Policy": "frame-src 'self'" },
      ),
    );
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 120,
      fetch: app.fetch,
    });
    baseUrl = server.url.origin;
    const mcp = createMcpHttpHandler({ baseUrl });
    app.all("/mcp", (c) => mcp(c.req.raw));
    let externalRequests = 0;
    let rtcPackets = 0;
    const stun = createSocket("udp4");
    stun.on("message", () => rtcPackets++);
    await new Promise<void>((resolve) => stun.bind(0, "127.0.0.1", resolve));
    const stunPort = stun.address().port;
    const external = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        externalRequests++;
        return new Response("external");
      },
    });
    const { default: puppeteer } = await import("puppeteer-core");
    const browser = await puppeteer.launch({
      executablePath: browserExecutable(),
      headless: true,
      args: ["--no-sandbox", "--mute-audio"],
    });
    const client = new Client({ name: "isolation-test", version: "1" });
    const request = (path: string, body?: unknown) =>
      fetch(
        `${baseUrl}${path}`,
        body === undefined
          ? undefined
          : {
              method: "POST",
              headers: { origin: baseUrl, "content-type": "application/json" },
              body: JSON.stringify(body),
            },
      );
    const pendingProject = async (name: string) => {
      const project = await projects.create({
        name,
        width: 320,
        height: 240,
        duration: 1,
      });
      const session = await agents.create({
        projectId: project.id,
        provider: "claude",
      });
      const waiting = new Promise<void>((resolve) => {
        const unsubscribe = agents.subscribe(session.id, ({ event }) => {
          if (event.type !== "request") return;
          unsubscribe();
          resolve();
        });
      });
      await agents.send(session.id, {
        text: "Edit",
        skills: [],
        attachments: [],
      });
      await waiting;
      await writeFile(join(project.path, "local.json"), '{"asset":"local"}');
      const script = `
        window.attacks = {};
        const attempt = async (name, run) => {
          try { const response = await run(); window.attacks[name] = response.status; }
          catch { window.attacks[name] = "blocked"; }
        };
        const annotation = ${JSON.stringify(`${baseUrl}/api/cutroom/projects/${project.id}/annotations`)};
        const approval = ${JSON.stringify(`${baseUrl}/api/cutroom/agents/sessions/${session.id}/responses`)};
        const post = (body) => ({method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
        Promise.all([
          attempt("annotation", () => fetch(annotation, post({kind:"comment",body:"composition wrote this",time:0}))),
          attempt("approval", () => fetch(approval, post({requestId:"approval",decision:"allow"}))),
          attempt("projects", () => fetch(${JSON.stringify(`${baseUrl}/api/cutroom/projects`)})),
          attempt("parent", () => parent.fetch(annotation, post({kind:"comment",body:"parent wrote this",time:0}))),
          attempt("external", () => fetch(${JSON.stringify(external.url.href)})),
          fetch("local.json").then(r=>r.json()).then(data=>{window.attacks.asset=data.asset;})
        ]).then(()=>{window.attacks.done=true;});
        new Image().src = ${JSON.stringify(`${external.url}pixel`)};
        const peer = new RTCPeerConnection({iceServers:[{urls:"stun:127.0.0.1:${stunPort}"}]});
        peer.createDataChannel("exfiltration");
        peer.createOffer().then(offer=>peer.setLocalDescription(offer)).catch(()=>{});
      `;
      await writeFile(
        join(project.path, "index.html"),
        `<!doctype html><html><head><style>body{margin:0}</style></head><body><main data-composition-id="main" data-width="320" data-height="240" data-duration="1"><div id="picture" class="clip" data-start="0" data-duration="1" data-track-index="0" style="position:absolute;inset:0;background:blue"></div></main><script>${script}</script></body></html>`,
      );
      return { project, session };
    };
    const unchanged = async (
      fixture: Awaited<ReturnType<typeof pendingProject>>,
    ) => {
      const document = ProjectDocumentSchema.parse(
        JSON.parse(
          await readFile(join(fixture.project.path, "cutroom.json"), "utf8"),
        ),
      );
      expect(document.annotations).toEqual([]);
      expect(agents.get(fixture.session.id).pendingRequest?.id).toBe(
        "approval",
      );
      expect(externalRequests).toBe(0);
      expect(rtcPackets).toBe(0);
    };
    try {
      // The retained legacy route is also a before-fix control using exactly the same attack.
      const legacy = await pendingProject("Legacy control");
      const old = await browser.newPage();
      await old.goto(`${baseUrl}/api/projects/${legacy.project.id}/preview`);
      await old.waitForFunction("window.attacks?.done === true");
      expect(await old.evaluate("window.attacks.annotation")).toBe(201);
      expect(await old.evaluate("window.attacks.approval")).toBe(200);
      expect(await old.evaluate("window.attacks.projects")).toBe(200);
      expect(await old.evaluate("window.attacks.parent")).toBe(201);
      expect(externalRequests).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(rtcPackets).toBeGreaterThan(0);
      await old.close();
      externalRequests = 0;
      rtcPackets = 0;

      const preview = await pendingProject("Isolated preview");
      const page = await browser.newPage();
      await page.goto(`${baseUrl}/host/${preview.project.id}`);
      await page.waitForFrame((frame) => frame.url().includes("/isolated/"));
      const frame = page
        .frames()
        .find((frame) => frame.url().includes("/isolated/"))!;
      await frame.waitForFunction("window.attacks?.done === true");
      expect(await frame.evaluate("window.attacks")).toMatchObject({
        annotation: "blocked",
        approval: "blocked",
        projects: "blocked",
        parent: "blocked",
        external: "blocked",
        asset: "local",
      });
      expect(
        await page.evaluate('document.querySelector("iframe").contentDocument'),
      ).toBeNull();
      // A frame cannot discard its CSP by navigating to an external document.
      await frame.evaluate((url) => {
        location.href = url;
      }, external.url.href);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await unchanged(preview);
      await page.close();

      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
          requestInit: { headers: { origin: baseUrl } },
        }),
      );
      const timeline = await pendingProject("Timeline capture");
      const view = await client.callTool({
        name: "timeline_view",
        arguments: { projectId: timeline.project.id, frame: 0 },
      });
      expect(view.isError).not.toBe(true);
      expect(view.content).toContainEqual(
        expect.objectContaining({ type: "image" }),
      );
      await unchanged(timeline);

      const thumbnail = await pendingProject("Thumbnail");
      const captured = await request(
        `/api/projects/${thumbnail.project.id}/thumbnail/index.html?t=0&format=png&output=source`,
      );
      expect(captured.status).toBe(200);
      expect((await captured.arrayBuffer()).byteLength).toBeGreaterThan(100);
      await unchanged(thumbnail);

      const render = await pendingProject("Export");
      const started = await request(
        `/api/projects/${render.project.id}/render`,
        { fps: 2, quality: "draft", format: "mp4", telemetryOptOut: true },
      );
      const { jobId } = z
        .object({ jobId: z.string() })
        .parse(await started.json());
      const progress = await (
        await request(`/api/render/${jobId}/progress`)
      ).text();
      expect(progress).toContain('"status":"complete"');
      expect((await request(`/api/render/${jobId}/download`)).status).toBe(200);
      await unchanged(render);

      const marked = await request(
        `/api/projects/${render.project.id}/render`,
        {
          fps: 30,
          quality: "draft",
          format: "mp4",
          cutroom: {
            filename: "marked.mp4",
            directory: render.project.path,
            range: { start: 5, end: 10 },
          },
        },
      );
      const markedJob = z
        .object({ jobId: z.string() })
        .parse(await marked.json());
      expect(
        await (await request(`/api/render/${markedJob.jobId}/progress`)).text(),
      ).toContain('"status":"complete"');
      await unchanged(render);
    } finally {
      await client.close();
      await browser.close();
      await agents.dispose();
      await editor.dispose();
      await projects.close();
      await server.stop(true);
      await external.stop(true);
      await new Promise<void>((resolve) => stun.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);
