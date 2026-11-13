import { expect, test } from "bun:test";
import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import {
  AnimationFeedbackSchema,
  TimelineViewSchema,
} from "../src/shared/timeline/schema";
import type {
  AnimationLeftBehind,
  CommandInput,
} from "../src/shared/timeline/schema";
import { reviewTweenScripts } from "../e2e/fixtures/animation-feedback/review-cases";
import { reviewR2Cases } from "../e2e/fixtures/animation-feedback/review-r2";
import { r3Composition } from "../e2e/fixtures/animation-feedback/review-r3";
import { projectFixture } from "./project-fixture";

const scripts = (html: string) => html.match(/<script\b[^]*?<\/script>/gi);
const composition = (script: string, extra = "") =>
  `<!doctype html><html><body><main id="main" data-composition-id="main" data-fps="30" data-duration="48"><div id="cta" class="clip title cta" data-start="36" data-duration="8" data-track-index="0">CTA</div><div id="shot-b" class="clip" data-start="36" data-duration="8" data-track-index="1">Shot${extra}</div></main><script>${script}</script></body></html>`;
const simple =
  'const tl=gsap.timeline({paused:true});tl.to("#cta",{opacity:1,duration:1},36);window.__timelines.main=tl;';

for (const command of [
  { type: "remove", clipIds: ["shot"], ripple: true },
  { type: "trim", clipId: "shot", edge: "start", to: 75, ripple: true },
  { type: "trim", clipId: "shot", edge: "end", to: 75, ripple: true },
] satisfies CommandInput[]) {
  test(`${command.type}${"edge" in command ? ` ${command.edge}` : ""} keeps a spanning title's animation origin and warns only for the displaced title`, async () => {
    const f =
      await fixture(`<main id="main" data-composition-id="main" data-fps="30" data-duration="6">
<div id="shot" class="clip" data-start="2" data-duration="1" data-track-index="0">Interview</div>
<div id="lower" class="clip" data-start="1" data-duration="4" data-track-index="1">Lower third</div>
<div id="later" class="clip" data-start="5" data-duration="1" data-track-index="2">Later title</div>
</main><script>const tl=gsap.timeline({paused:true});tl.to('#lower',{opacity:1},1);tl.to('#later',{opacity:1},5);window.__timelines.main=tl;</script>`);
    try {
      const result = await f.edit([command]);
      expect(result.animationLeftBehind?.map((clip) => clip.clipId)).toEqual([
        "later",
      ]);
      expect(
        result.timeline.clips.find((clip) => clip.id === "lower"),
      ).toMatchObject({
        start: 30,
        duration: command.type === "remove" ? 90 : 105,
      });
      expect(
        result.timeline.clips.filter((clip) => clip.track === 1),
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
}

async function fixture(html: string) {
  const fixture = await projectFixture();
  const routes = createTimelineRoutes(fixture.store, fixture.review);
  fixture.app.route("/api/cutroom", routes);
  const project = await fixture.store.create({ name: "Animation feedback" });
  const file = join(project.path, "index.html");
  await writeFile(file, html);
  const base = `/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await fixture.request(`${base}/timeline`)).json(),
    );
  const edit = async (commands: CommandInput[]) => {
    const done = Promise.withResolvers<{ clips: AnimationLeftBehind[] }>();
    const stop = routes.subscribeAnimationFeedback(project.id, done.resolve);
    try {
      const response = await fixture.request(`${base}/commands`, "POST", {
        expectedRevision: (await read()).revision,
        commands,
      });
      const body: unknown = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(scripts(await readFile(file, "utf8"))).toEqual(scripts(html));
      expect(body).not.toHaveProperty("animationLeftBehind");
      const feedback = await done.promise;
      return {
        ...TimelineViewSchema.parse(body),
        animationLeftBehind: feedback.clips.length ? feedback.clips : undefined,
      };
    } finally {
      stop();
    }
  };
  return { ...fixture, routes, project, file, base, read, edit };
}

test("W overlap warns for both the shortened/displaced lower third and later title without touching script", async () => {
  const f = await fixture(
    await readFile(
      new URL(
        "../e2e/fixtures/animation-feedback/overlap.html",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  try {
    const result = await f.edit([
      { type: "trim", clipId: "shot", edge: "end", to: 30, ripple: true },
    ]);
    expect(result.animationLeftBehind?.map((c) => c.clipId).sort()).toEqual([
      "other",
      "title",
    ]);
    expect(result.timeline.clips.find((c) => c.id === "title")).toMatchObject({
      start: 30,
      duration: 60,
    });
    expect(result.timeline.clips.find((c) => c.id === "other")).toMatchObject({
      start: 150,
      duration: 120,
    });
  } finally {
    await f.close();
  }
});

test("pure head/tail trims and a batch returning to its original origin stay quiet", async () => {
  for (const commands of [
    [{ type: "trim", clipId: "cta", edge: "start", to: 1110 }],
    [{ type: "trim", clipId: "cta", edge: "end", to: 1290 }],
    [
      { type: "move", clipIds: ["cta"], by: 30, mode: "place" },
      { type: "move", clipIds: ["cta"], by: -30, mode: "place" },
    ],
  ] satisfies CommandInput[][]) {
    const f = await fixture(composition(simple));
    try {
      expect((await f.edit(commands)).animationLeftBehind).toBeUndefined();
    } finally {
      await f.close();
    }
  }
});

test("head trim plus displacement in one batch warns, without leaking source offsets", async () => {
  const f = await fixture(composition(simple));
  try {
    const result = await f.edit([
      { type: "trim", clipId: "cta", edge: "start", to: 1110 },
      { type: "move", clipIds: ["cta"], by: -60, mode: "place" },
    ]);
    expect(result.animationLeftBehind?.map((c) => c.clipId)).toEqual(["cta"]);
    expect(
      await readFile(join(f.project.path, "cutroom.json"), "utf8"),
    ).not.toContain("animation");
  } finally {
    await f.close();
  }
});

for (const [name, script] of Object.entries({
  ...reviewTweenScripts,
  laterInline: 'const hint="gsap.timeline";</script><script>' + simple,
  loop: 'const tl=gsap.timeline({paused:true});for(let i=0;i<2;i++)tl.to("#cta",{x:i*100},36+i);window.__timelines.main=tl;',
}))
  test(`R1 ${name} is toast-only`, async () => {
    const f = await fixture(composition(script));
    try {
      expect(
        (
          await f.edit([
            { type: "move", clipIds: ["cta"], by: 30, mode: "place" },
          ])
        ).animationLeftBehind?.map((c) => c.clipId),
      ).toEqual(["cta"]);
    } finally {
      await f.close();
    }
  });

for (const [name, example] of Object.entries(reviewR2Cases))
  test(`R2 ${name} is toast-only`, async () => {
    const f = await fixture(
      composition(
        example.script,
        "duplicate" in example ? '<span id="cta">duplicate</span>' : "",
      ).replace("</body>", `${"extra" in example ? example.extra : ""}</body>`),
    );
    try {
      if ("external" in example)
        await writeFile(join(f.project.path, "follow.js"), example.external);
      expect(
        (
          await f.edit([
            { type: "move", clipIds: ["cta"], by: 30, mode: "place" },
          ])
        ).animationLeftBehind?.map((c) => c.clipId),
      ).toEqual(["cta"]);
    } finally {
      await f.close();
    }
  });
for (const kind of [
  "nested",
  "inline",
  "quirks",
  "precision",
  "plain",
] as const)
  test(`R3 ${kind} is toast-only`, async () => {
    const f = await fixture(r3Composition(kind));
    try {
      expect(
        (
          await f.edit([
            { type: "move", clipIds: ["cta"], by: 1, mode: "place" },
          ])
        ).animationLeftBehind?.map((c) => c.clipId),
      ).toEqual(["cta"]);
    } finally {
      await f.close();
    }
  });
for (const kind of [
  "autoVideoFront",
  "noscriptScript",
  "svgUse",
  "smil",
  "tableOwner",
])
  test(`R4 ${kind} is toast-only`, async () => {
    const f = await fixture(
      await readFile(
        new URL(
          `../e2e/fixtures/animation-feedback/review-r4/${kind}.html`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    try {
      expect(
        (
          await f.edit([
            { type: "move", clipIds: ["cta"], by: 30, mode: "place" },
          ])
        ).animationLeftBehind?.map((c) => c.clipId),
      ).toContain("cta");
    } finally {
      await f.close();
    }
  });

test("razor pieces and pasted copies warn from their source animation", async () => {
  const html = composition(simple.replace('"#cta"', '".title"'));
  const f = await fixture(html);
  try {
    const result = await f.edit([
      { type: "split", clipIds: ["cta"], at: 1200, ids: { cta: ["piece"] } },
    ]);
    expect(result.animationLeftBehind?.map((c) => c.clipId)).toEqual(["piece"]);
    const copied = await (
      await f.request(`${f.base}/timeline/copy`, "POST", {
        expectedRevision: (await f.read()).revision,
        clipIds: ["cta"],
      })
    ).json();
    const pasted = await f.edit([
      {
        type: "paste",
        clipboardId: copied.id,
        at: 0,
        ids: { cta: ["pasted"] },
      },
    ]);
    expect(pasted.animationLeftBehind?.map((c) => c.clipId)).toContain(
      "pasted",
    );
  } finally {
    await f.close();
  }
});

test("unrelated Map.set and file-based clip-local animation stay silent", async () => {
  for (const html of [
    composition('new Map().set("#cta",{opacity:1});'),
    composition("").replace(
      'id="cta" class="clip title cta"',
      'id="cta" class="clip title cta" data-composition-id="child" data-composition-src="child.html"',
    ),
  ]) {
    const f = await fixture(html);
    try {
      expect(
        (
          await f.edit([
            { type: "move", clipIds: ["cta"], by: 30, mode: "place" },
          ])
        ).animationLeftBehind,
      ).toBeUndefined();
    } finally {
      await f.close();
    }
  }
});

test("razoring an unrelated clip stays quiet when the parser cannot expand a chained title timeline", async () => {
  const f = await fixture(
    composition(
      `window.__timelines.main=gsap.timeline({paused:true}).fromTo('#cta',{opacity:0},{opacity:1,duration:.5});`,
    ),
  );
  try {
    const result = await f.edit([
      {
        type: "split",
        clipIds: ["shot-b"],
        at: 1200,
        ids: { "shot-b": ["piece"] },
      },
    ]);
    expect(result.animationLeftBehind).toBeUndefined();
    const moved = await f.edit([
      { type: "move", clipIds: ["cta"], by: 30, mode: "place" },
    ]);
    expect(moved.animationLeftBehind?.map((c) => c.clipId)).toEqual(["cta"]);
  } finally {
    await f.close();
  }
});

for (const target of [
  '".clip.title"',
  '"div.clip.title"',
  "`" + ".clip.title" + "`",
  "selector",
])
  test(`complete selector ${target} leaves unrelated shots quiet`, async () => {
    const f = await fixture(
      composition(
        `document.getElementById("cta");const selector=".clip.title";const tl=gsap.timeline({paused:true});tl.to(${target},{opacity:1},36);window.__timelines.main=tl;`,
      ),
    );
    try {
      expect(
        (
          await f.edit([
            { type: "move", clipIds: ["shot-b"], by: 30, mode: "place" },
          ])
        ).animationLeftBehind,
      ).toBeUndefined();
      expect(
        (
          await f.edit([
            { type: "move", clipIds: ["cta"], by: 30, mode: "place" },
          ])
        ).animationLeftBehind?.map((c) => c.clipId),
      ).toEqual(["cta"]);
    } finally {
      await f.close();
    }
  });
test("sub-composition hosts never warn, even when a root tween names the host", async () => {
  const f = await fixture(
    composition(simple).replace(
      'id="cta" class="clip title cta"',
      'id="cta" class="clip title cta" data-composition-id="child" data-composition-src="child.html"',
    ),
  );
  try {
    expect(
      (
        await f.edit([
          { type: "move", clipIds: ["cta"], by: 30, mode: "place" },
        ])
      ).animationLeftBehind,
    ).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("MCP acknowledges an edit before its warning follow-up", async () => {
  const f = await fixture(composition(simple));
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } =
    await import("@modelcontextprotocol/sdk/inMemory.js");
  const { LoggingMessageNotificationSchema } =
    await import("@modelcontextprotocol/sdk/types.js");
  const { createMcpServer } = await import("../src/server/mcp/server");
  const { AnimationFeedbackSchema } =
    await import("../src/shared/timeline/schema");
  const server = createMcpServer({
    baseUrl: "http://127.0.0.1:4950",
    fetch: (url, init) => f.app.request(new URL(url).pathname, init),
  });
  const client = new Client({ name: "animation-followup-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const warning = Promise.withResolvers<unknown>();
  const order: string[] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
    order.push("warning");
    warning.resolve(n.params.data);
  });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: f.project.id,
        expectedRevision: (await f.read()).revision,
        commands: [{ type: "move", clipIds: ["cta"], by: 30, mode: "place" }],
      },
    });
    order.push("result");
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).not.toHaveProperty(
      "result.animationLeftBehind",
    );
    const feedback = AnimationFeedbackSchema.parse(await warning.promise);
    expect(feedback.clips.map((c) => c.clipId)).toEqual(["cta"]);
    expect(order).toEqual(["result", "warning"]);
  } finally {
    await client.close();
    await server.close();
    await f.close();
  }
});

test("media elements carrying composition-host attributes never warn", async () => {
  const f = await fixture(
    composition(simple)
      .replace(
        '<div id="cta"',
        '<img data-composition-src="child.html" id="cta"',
      )
      .replace(">CTA</div>", ">"),
  );
  try {
    expect(
      (
        await f.edit([
          { type: "move", clipIds: ["cta"], by: 30, mode: "place" },
        ])
      ).animationLeftBehind,
    ).toBeUndefined();
  } finally {
    await f.close();
  }
});

for (const unrelated of [
  'const shot=document.getElementById("shot-b");',
  'const byId=new Map();byId.set("#shot-b",{label:"Shot"});',
])
  test(`resolved GSAP target ignores unrelated lookup ${unrelated}`, async () => {
    const f = await fixture(composition(unrelated + simple));
    try {
      expect(
        (
          await f.edit([
            { type: "move", clipIds: ["shot-b"], by: 1, mode: "place" },
          ])
        ).animationLeftBehind,
      ).toBeUndefined();
      expect(
        (
          await f.edit([
            { type: "move", clipIds: ["cta"], by: 1, mode: "place" },
          ])
        ).animationLeftBehind?.map((c) => c.clipId),
      ).toEqual(["cta"]);
    } finally {
      await f.close();
    }
  });

for (const script of [
  'gsap["to"]("#cta",{x:100,duration:1,delay:36});',
  'const tl=gsap["timeline"]({paused:true});tl["to"]("#cta",{x:100},36);window.__timelines.main=tl;',
])
  test(`literal computed GSAP member warns: ${script}`, async () => {
    const f = await fixture(composition(script));
    try {
      expect(
        (
          await f.edit([
            { type: "move", clipIds: ["cta"], by: 1, mode: "place" },
          ])
        ).animationLeftBehind?.map((c) => c.clipId),
      ).toEqual(["cta"]);
      expect(
        (
          await f.edit([
            { type: "move", clipIds: ["shot-b"], by: 1, mode: "place" },
          ])
        ).animationLeftBehind,
      ).toBeUndefined();
    } finally {
      await f.close();
    }
  });

test("rapid MCP edit notifications identify their request and saved revision", async () => {
  const f = await fixture(composition(simple));
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } =
    await import("@modelcontextprotocol/sdk/inMemory.js");
  const { LoggingMessageNotificationSchema, RequestIdSchema } =
    await import("@modelcontextprotocol/sdk/types.js");
  const { createMcpServer } = await import("../src/server/mcp/server");
  const { AnimationFeedbackSchema } =
    await import("../src/shared/timeline/schema");
  const payload = AnimationFeedbackSchema.extend({
    requestId: RequestIdSchema,
  });
  const server = createMcpServer({
    baseUrl: "http://127.0.0.1:4950",
    fetch: (url, init) => f.app.request(new URL(url).pathname, init),
  });
  const client = new Client({
    name: "correlated-animation-test",
    version: "1",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const requests: z.infer<typeof RequestIdSchema>[] = [];
  const expected: {
    requestId: z.infer<typeof RequestIdSchema>;
    revision: string;
  }[] = [];
  const notifications: z.infer<typeof payload>[] = [];
  const done = Promise.withResolvers<void>();
  client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
    try {
      notifications.push(payload.parse(n.params.data));
      if (notifications.length === 12) done.resolve();
    } catch (error) {
      done.reject(error);
    }
  });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const receive = serverTransport.onmessage!;
    serverTransport.onmessage = (message, extra) => {
      if (
        "id" in message &&
        "method" in message &&
        message.method === "tools/call"
      )
        requests.push(message.id);
      receive(message, extra);
    };
    let view = await f.read();
    for (let i = 0; i < 12; i++) {
      const result = await client.callTool({
        name: "timeline_edit",
        arguments: {
          projectId: f.project.id,
          expectedRevision: view.revision,
          commands: [{ type: "move", clipIds: ["cta"], by: 1, mode: "place" }],
        },
      });
      expect(result.isError).not.toBe(true);
      view = z
        .object({ result: TimelineViewSchema })
        .parse(result.structuredContent).result;
      expected.push({ requestId: requests[i], revision: view.revision });
    }
    await done.promise;
    expect(
      notifications.map(({ requestId, revision }) => ({ requestId, revision })),
    ).toEqual(expected);
    expect(new Set(notifications.map((n) => n.requestId)).size).toBe(12);
    expect(notifications.every((n) => n.origin === null)).toBe(true);
  } finally {
    await client.close();
    await server.close();
    await f.close();
  }
});

test("project SSE delivers animation feedback only to the command's tab origin", async () => {
  const f = await fixture(composition(simple));
  const { createWorkspaceRoutes } = await import("../src/server/workspace");
  f.app.route(
    "/api/cutroom",
    createWorkspaceRoutes({
      projects: f.store,
      review: f.review,
      dataDir: f.directory,
      projectsDir: f.store.projectsDir,
      mcpCommand: "cutroom mcp",
      subscribeAnimationFeedback: f.routes.subscribeAnimationFeedback,
    }),
  );
  const own = crypto.randomUUID();
  const streams = await Promise.all(
    [own, crypto.randomUUID(), null].map(async (origin) => {
      const response = await f.request(
        `${f.base}/events${origin ? `?origin=${origin}` : ""}`,
      );
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const animation = Promise.withResolvers<void>();
      const changed = Promise.withResolvers<void>();
      const pump = (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          text += decoder.decode(value);
          if (text.includes("event: animation-left-behind"))
            animation.resolve();
          if (text.includes('"changed":"index.html"')) changed.resolve();
        }
      })();
      return {
        reader,
        pump,
        animation: animation.promise,
        changed: changed.promise,
        text: () => text,
      };
    }),
  );
  try {
    const response = await f.app.request(`/api/cutroom${f.base}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cutroom-tab-origin": own,
      },
      body: JSON.stringify({
        expectedRevision: (await f.read()).revision,
        commands: [{ type: "move", clipIds: ["cta"], by: 1, mode: "place" }],
      }),
    });
    const view = TimelineViewSchema.parse(await response.json());
    await streams[0].animation;
    // The source watcher follows the diagnostic on all three project streams.
    await Promise.all(streams.map((s) => s.changed));
    const frame = streams[0]
      .text()
      .split("\n\n")
      .find((frame) => frame.startsWith("event: animation-left-behind"))!;
    const feedback = AnimationFeedbackSchema.parse(
      JSON.parse(frame.split("\ndata: ")[1]),
    );
    expect(feedback.origin).toBe(own);
    expect(feedback.revision).toBe(view.revision);
    expect(streams[1].text()).not.toContain("event: animation-left-behind");
    expect(streams[2].text()).not.toContain("event: animation-left-behind");
  } finally {
    await Promise.all(
      streams.map(async (s) => {
        await s.reader.cancel();
        await s.pump;
      }),
    );
    await f.close();
  }
});
