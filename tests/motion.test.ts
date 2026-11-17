import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createMotionRoutes } from "../src/server/projects/motion";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { createMcpServer } from "../src/server/mcp/server";
import {
  codexToolPermissions,
  claudeToolPermissions,
  isCutroomEdit,
} from "../src/server/agents/tool-permissions";
import { AGENT_HEADER } from "../src/shared/review";
import { MotionSnapshotSchema } from "../src/shared/motion";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import type { MotionChange, MotionSnapshot } from "../src/shared/motion";
import { projectFixture } from "./project-fixture";

const script = `// Source layout is intentional.
const tl = gsap.timeline({ paused: true, defaults: { ease: "power1.out" } });
tl.fromTo('#card', { x: -20, opacity: 0 }, { x: 200 /* keep */, opacity: 1, duration: 2, ease: 'none', onComplete: () => console.log("done"), repeat: 1 }, 0);
window.__timelines ??= {};
window.__timelines['main'] = tl;`;
const html = (code = script) => `<!doctype html><html><body>
<main id="root" data-composition-id="main" data-width="640" data-height="360" data-fps="30" data-duration="4">
<div id="card" class="clip shape" data-start="0" data-duration="4" data-track-index="0"></div>
<div id="other" class="clip shape" data-start="0" data-duration="4" data-track-index="1"></div>
</main><script>${code}</script>
<template><div data-composition-id="nested"><div id="card"></div><script>const nested = gsap.timeline(); nested.to('#card', {x:999}, 0);</script></div></template>
<script type="application/json">{"unrelated":true}</script></body></html>`;

async function fixture(code = script) {
  const f = await projectFixture();
  f.app.route("/api/cutroom", createMotionRoutes(f.store, f.review));
  f.app.route("/api/cutroom", createTimelineRoutes(f.store, f.review));
  const project = await f.store.create({
    name: "Motion",
    duration: 4,
    width: 640,
    height: 360,
  });
  const file = join(project.path, "index.html");
  await writeFile(file, html(code));
  const base = `/projects/${project.id}`;
  const read = async (composition = "index.html", clipId = "card") =>
    MotionSnapshotSchema.parse(
      await (
        await f.request(
          `${base}/motion?${new URLSearchParams({ composition, clipId })}`,
        )
      ).json(),
    );
  const update = (snapshot: MotionSnapshot, change: MotionChange, index = 0) =>
    f.request(`${base}/motion`, "POST", {
      composition: snapshot.composition,
      clipId: snapshot.clipId,
      expectedVersion: snapshot.version,
      animationId: snapshot.animations[index]!.id,
      change,
    });
  return {
    ...f,
    project,
    base,
    file,
    read,
    update,
    source: () => readFile(file, "utf8"),
  };
}

test("literal fromTo edits change only the requested bytes and share Undo/Redo", async () => {
  const f = await fixture();
  try {
    const before = await f.source();
    const snapshot = await f.read();
    expect(snapshot.animations).toHaveLength(1);
    expect(snapshot.animations[0]).toMatchObject({
      from: { x: -20, opacity: 0 },
      to: { x: 200, opacity: 1 },
      position: 0,
      duration: 2,
      ease: "none",
      reason: null,
      targets: ["#card"],
    });
    expect(
      (
        await f.update(snapshot, {
          kind: "property",
          side: "to",
          name: "x",
          value: 320,
        })
      ).status,
    ).toBe(200);
    const after = before.replace("x: 200", "x: 320");
    expect(await f.source()).toBe(after);
    expect((await f.request(`${f.base}/history/undo`, "POST")).ok).toBe(true);
    expect(await f.source()).toBe(before);
    expect((await f.request(`${f.base}/history/redo`, "POST")).ok).toBe(true);
    expect(await f.source()).toBe(after);
    const history = z
      .object({ entries: z.array(z.object({ label: z.string() })) })
      .parse(await (await f.request(`${f.base}/history`)).json());
    expect(
      history.entries.filter((item) => item.label === "Edit card motion"),
    ).toHaveLength(1);
    const from = await f.read();
    expect(
      (
        await f.update(from, {
          kind: "property",
          side: "from",
          name: "x",
          value: -80,
        })
      ).ok,
    ).toBe(true);
    expect(await f.source()).toBe(after.replace("x: -20", "x: -80"));
  } finally {
    await f.close();
  }
});

test("stale IDs after an external insertion or concurrent edits never change a different tween", async () => {
  const f = await fixture();
  try {
    const stale = await f.read();
    const changed = (await f.source()).replace(
      "tl.fromTo",
      "tl.to('#card', {x:777, duration:1}, 0);\ntl.fromTo",
    );
    await writeFile(f.file, changed);
    expect(
      (
        await f.update(stale, {
          kind: "property",
          side: "to",
          name: "x",
          value: 999,
        })
      ).status,
    ).toBe(409);
    expect(await f.source()).toBe(changed);
    const snapshot = await f.read();
    const replies = await Promise.all([
      f.update(snapshot, {
        kind: "property",
        side: "to",
        name: "x",
        value: 101,
      }),
      f.update(snapshot, {
        kind: "property",
        side: "to",
        name: "x",
        value: 102,
      }),
    ]);
    expect(replies.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const winner = replies[0]!.status === 200 ? 101 : 102;
    expect(await f.source()).toBe(changed.replace("x:777", `x:${winner}`));
    const accepted = replies.find((response) => response.status === 200)!;
    const refused = replies.find((response) => response.status === 409)!;
    expect(await refused.text()).toContain("The source changed");
    const saved = MotionSnapshotSchema.parse(await accepted.json());
    expect(saved.animations[0]!.to.x).toBe(winner);
    expect((await f.read()).version).toBe(saved.version);
    const history = z
      .object({ entries: z.array(z.object({ label: z.string() })) })
      .parse(await (await f.request(`${f.base}/history`)).json());
    expect(
      history.entries.filter((entry) => entry.label === "Edit card motion"),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("to/from/set and literal timing/ease edit in place, including global sets", async () => {
  const f = await fixture(`const tl = gsap.timeline({paused:true});
tl.to('#card', { x: 100, y: 80, duration: 2, ease: 'none' }, 0);
tl.from('#card', { opacity: 0, duration: 1 }, 1);
tl.set('#card', { rotation: 20 }, 2);
gsap.set('#card', { scale: 1 });
window.__timelines ??= {}; window.__timelines['main'] = tl;`);
  try {
    for (const [index, change, needle] of [
      [0, { kind: "duration", value: 3 }, "duration: 3"],
      [0, { kind: "position", value: 0.5 }, "}, 0.5)"],
      [0, { kind: "ease", value: "power2.out" }, 'ease: "power2.out"'],
      [
        1,
        { kind: "property", side: "from", name: "opacity", value: 0.25 },
        "opacity: 0.25",
      ],
      [
        2,
        { kind: "property", side: "to", name: "rotation", value: 60 },
        "rotation: 60",
      ],
      [
        3,
        { kind: "property", side: "to", name: "scale", value: 2 },
        "scale: 2",
      ],
    ] as const) {
      const before = await f.source();
      const response = await f.update(await f.read(), change, index);
      expect(await response.text()).not.toContain('"error"');
      expect(response.ok).toBe(true);
      expect(await f.source()).toContain(needle);
      if (index === 3)
        expect((await f.source()).indexOf("gsap.set")).toBeGreaterThan(
          (await f.source()).indexOf("tl.set"),
        );
      expect((await f.request(`${f.base}/history/undo`, "POST")).ok).toBe(true);
      expect(await f.source()).toBe(before);
    }
  } finally {
    await f.close();
  }
});

test("computed, helper, loop and multiple timeline forms preserve source with an honest reason", async () => {
  const cases = [
    `const tl=gsap.timeline(); const target='#card'; tl.to(target,{x:20},0);`,
    `const tl=gsap.timeline(); for(let i=0;i<2;i++){tl.to('#card',{x:20},0)}`,
    `const tl=gsap.timeline(); function move(){tl.to('#card',{x:20},0)} move();`,
    `const tl=gsap.timeline(); const other=gsap.timeline(); tl.to('#card',{x:20},0);`,
    `const tl=gsap.timeline(); tl.to('#card',{...vars,x:20},0);`,
    `const tl=gsap.timeline(); tl.to('#card',{x:20,x:30},0);`,
    `const tl=gsap.timeline(); tl.to('#card',{keyframes:{'0%':{x:0},'100%':{x:20}}},0);`,
    `const tl=gsap.timeline(); const alias=tl; tl.to('#card',{x:20},0);`,
    `gsap.to('#card',{x:20});`,
  ];
  for (const code of cases) {
    const f = await fixture(code);
    try {
      const before = await f.source();
      const snapshot = await f.read();
      expect(
        snapshot.reason ||
          snapshot.notices.length ||
          snapshot.animations.some((entry) => entry.reason),
      ).toBeTruthy();
      if (snapshot.animations.length)
        expect(
          (
            await f.update(snapshot, {
              kind: "property",
              side: "to",
              name: "x",
              value: 99,
            })
          ).status,
        ).toBe(422);
      expect(await f.source()).toBe(before);
    } finally {
      await f.close();
    }
  }
});

test("computed fields remain source-only while literal siblings are editable; no new fields or code easing", async () => {
  const f = await fixture(
    `const tl=gsap.timeline(); const n=20; tl.to('#card',{x:n,y:50,duration:n,ease:()=>0.5},'>');`,
  );
  try {
    const snapshot = await f.read();
    expect(snapshot.animations[0]).toMatchObject({
      to: { y: 50 },
      duration: null,
      position: null,
      ease: null,
    });
    expect(snapshot.animations[0]!.sourceOnly).toContain("to.x");
    for (const change of [
      { kind: "property", side: "to", name: "x", value: 30 },
      { kind: "property", side: "to", name: "rotation", value: 30 },
      { kind: "duration", value: 2 },
      { kind: "position", value: 1 },
      { kind: "ease", value: "__raw:alert(1)" },
    ] as const)
      expect((await f.update(snapshot, change)).status).toBe(422);
    expect(
      (
        await f.update(snapshot, {
          kind: "property",
          side: "to",
          name: "y",
          value: 70,
        })
      ).ok,
    ).toBe(true);
    expect(await f.source()).toBe(
      html(
        `const tl=gsap.timeline(); const n=20; tl.to('#card',{x:n,y:70,duration:n,ease:()=>0.5},'>');`,
      ),
    );
  } finally {
    await f.close();
  }
});

test("shared selectors report actual targets; external templates use their own source scope", async () => {
  const f = await fixture(
    `const tl=gsap.timeline(); tl.to('.shape',{x:100},0);`,
  );
  try {
    expect((await f.read()).animations[0]!.targets).toEqual([
      "#card",
      "#other",
    ]);
    await mkdir(join(f.project.path, "compositions"));
    const external = `<template><main data-composition-id="main" data-duration="4"><div id="card" class="clip" data-start="0" data-duration="4" data-track-index="0"></div></main><script>${script}</script></template><script src="custom.js"></script>`;
    const path = join(f.project.path, "compositions/scene.html");
    await writeFile(path, external);
    const state = await f.read("compositions/scene.html");
    expect(state.animations).toHaveLength(1);
    expect(
      (
        await f.update(state, {
          kind: "property",
          side: "to",
          name: "x",
          value: 300,
        })
      ).ok,
    ).toBe(true);
    expect(await readFile(path, "utf8")).toBe(
      external.replace("x: 200", "x: 300"),
    );
    expect(await f.source()).toBe(
      html(`const tl=gsap.timeline(); tl.to('.shape',{x:100},0);`),
    );
    expect(
      (
        await f.request(
          `${f.base}/motion?composition=../outside.html&clipId=card`,
        )
      ).status,
    ).toBe(400);
  } finally {
    await f.close();
  }
});

test("typed MCP uses the same operation, attribution and native permissions; invalid tokens cannot write", async () => {
  const f = await fixture();
  const server = createMcpServer({
    fetch: (url, init) => f.app.request(url, init),
  });
  const client = new Client({ name: "motion-test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote);
  await client.connect(local);
  try {
    const read = await client.callTool({
      name: "motion_read",
      arguments: { projectId: f.project.id, clipId: "card" },
    });
    const result = z
      .object({ structuredContent: z.object({ result: MotionSnapshotSchema }) })
      .parse(read).structuredContent.result;
    const args = {
      projectId: f.project.id,
      composition: "index.html",
      clipId: "card",
      expectedVersion: result.version,
      animationId: result.animations[0]!.id,
      change: { kind: "property", side: "to", name: "x", value: 450 },
    };
    expect(
      (await client.callTool({ name: "motion_update", arguments: args }))
        .isError,
    ).not.toBe(true);
    expect(await f.source()).toContain("x: 450");
    const history = z
      .object({
        entries: z.array(
          z.object({ label: z.string(), who: z.object({ kind: z.string() }) }),
        ),
      })
      .parse(await (await f.request(`${f.base}/history`)).json());
    expect(
      history.entries.findLast((entry) => entry.label === "Edit card motion")
        ?.who.kind,
    ).toBe("agent");
    expect(
      (await client.callTool({ name: "motion_update", arguments: args }))
        .isError,
    ).toBe(true);
    const before = await f.source();
    const denied = await f.app.request(`/api/cutroom${f.base}/motion`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: "unknown-token",
      },
      body: JSON.stringify(args),
    });
    expect(denied.status).toBe(409);
    expect(await denied.text()).toContain("No Cutroom run is active");
    expect(await f.source()).toBe(before);
    expect(isCutroomEdit("mcp__cutroom_studio__motion_update")).toBe(true);
    expect(
      codexToolPermissions()[
        "mcp_servers.cutroom_studio.tools.motion_update.approval_mode"
      ],
    ).toBe("prompt");
    expect(
      codexToolPermissions(true)[
        "mcp_servers.cutroom_studio.tools.motion_update.approval_mode"
      ],
    ).toBe("approve");
    expect(claudeToolPermissions().allowedTools).toContain(
      "mcp__cutroom_studio__motion_read",
    );
    expect(claudeToolPermissions().allowedTools).not.toContain(
      "mcp__cutroom_studio__motion_update",
    );
    expect(claudeToolPermissions(true).allowedTools).toContain(
      "mcp__cutroom_studio__motion_update",
    );
    expect((await f.request(`${f.base}/history/undo`, "POST")).ok).toBe(true);
    expect(await f.source()).toBe(html());
  } finally {
    await client.close();
    await server.close();
    await f.close();
  }
});

test("a shared selector cannot change a locked target, even when the selected clip is unlocked", async () => {
  const f = await fixture(
    `const tl=gsap.timeline(); tl.to('.shape',{x:100},0);`,
  );
  try {
    const timeline = TimelineViewSchema.parse(
      await (await f.request(`${f.base}/timeline`)).json(),
    );
    expect(
      (
        await f.request(`${f.base}/commands`, "POST", {
          expectedRevision: timeline.revision,
          commands: [{ type: "setTrack", index: 1, locked: true }],
        })
      ).ok,
    ).toBe(true);
    const snapshot = await f.read();
    const source = await f.source();
    const response = await f.update(snapshot, {
      kind: "property",
      side: "to",
      name: "x",
      value: 200,
    });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("locked track");
    expect(await f.source()).toBe(source);
  } finally {
    await f.close();
  }
});

test("duplicate live ids, cross-script timeline uses and script-closing ease input cannot overwrite source", async () => {
  const f = await fixture();
  try {
    const snapshot = await f.read();
    expect(
      (
        await f.update(snapshot, {
          kind: "ease",
          value: "</script><script>1</script>",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await f.update(snapshot, {
          kind: "ease",
          value: "__raw:console.log(1)",
        })
      ).status,
    ).toBe(422);
    expect(await f.source()).toBe(html());
    await writeFile(f.file, html().replace('id="other"', 'id="card"'));
    expect((await f.read()).reason).toContain("unique authored element id");
    const crossScript = html().replace(
      "</body>",
      "<script>tl.add(otherTimeline);</script></body>",
    );
    await writeFile(f.file, crossScript);
    const cross = await f.read();
    expect(cross.reason).toContain("multiple scripts");
    expect(
      (
        await f.update(cross, {
          kind: "property",
          side: "to",
          name: "x",
          value: 999,
        })
      ).status,
    ).toBe(422);
    expect(await f.source()).toBe(crossScript);
  } finally {
    await f.close();
  }
});

test("locked motion ownership includes descendant targets and anonymous clips in each composition scope", async () => {
  for (const lockedContent of [
    `<div id="other" class="clip" data-start="0" data-duration="4" data-track-index="1"><span id="child" class="shape">Locked clip content</span></div>`,
    `<div class="clip shape" data-start="0" data-duration="4" data-track-index="1"></div>`,
  ]) {
    for (const composition of ["index.html", "compositions/scene.html"]) {
      const f = await fixture();
      const server = createMcpServer({
        fetch: (url, init) => f.app.request(url, init),
      });
      const client = new Client({ name: "motion-lock-test", version: "1" });
      const [local, remote] = InMemoryTransport.createLinkedPair();
      await server.connect(remote);
      await client.connect(local);
      try {
        const scene = `<main data-composition-id="main" data-duration="4"><div id="card" class="clip shape" data-start="0" data-duration="4" data-track-index="0"></div>${lockedContent}</main><script>const tl=gsap.timeline(); tl.to('.shape',{x:100 /* preserve */,duration:1,onComplete:()=>{}},0);</script>`;
        // Duplicate ids in an inactive template must not become targets or owners.
        const inactive = `<template><div id="card" class="shape"></div><span id="child" class="shape"></span></template>`;
        const source =
          composition === "index.html"
            ? `${scene}${inactive}`
            : `<template>${scene}</template>${inactive}`;
        const path = join(f.project.path, composition);
        await mkdir(join(f.project.path, "compositions"), { recursive: true });
        await writeFile(path, source);
        const timeline = async () =>
          TimelineViewSchema.parse(
            await (
              await f.request(
                `${f.base}/timeline?${new URLSearchParams({ composition })}`,
              )
            ).json(),
          );
        const setLock = async (locked: boolean) => {
          const view = await timeline();
          expect(
            (
              await f.request(`${f.base}/commands`, "POST", {
                composition,
                expectedRevision: view.revision,
                commands: [{ type: "setTrack", index: 1, locked }],
              })
            ).status,
          ).toBe(200);
        };
        const unlocked = await f.read(composition);
        expect(unlocked.animations[0]!.targets).toEqual([
          "#card",
          lockedContent.includes('id="other"') ? "#child" : "div (no id)",
        ]);
        expect(unlocked.animations[0]!.reason).toBeNull();
        const owner = (await timeline()).timeline.clips.find(
          (clip) => clip.track === 1,
        )!;
        expect(owner.id.length).toBeGreaterThan(0);
        if (!lockedContent.includes('id="other"'))
          expect(source).not.toContain(`id="${owner.id}"`);
        await setLock(true);
        const before = await readFile(path, "utf8");
        expect(before).toBe(source);
        // A previously unlocked snapshot must also respect the current lock.
        const refused = await f.update(unlocked, {
          kind: "property",
          side: "to",
          name: "x",
          value: 200,
        });
        expect(refused.status).toBe(422);
        expect(await refused.text()).toContain("locked track");
        expect(await readFile(path, "utf8")).toBe(before);
        const read = z
          .object({
            structuredContent: z.object({ result: MotionSnapshotSchema }),
          })
          .parse(
            await client.callTool({
              name: "motion_read",
              arguments: {
                projectId: f.project.id,
                clipId: "card",
                composition,
              },
            }),
          ).structuredContent.result;
        expect(read.animations[0]!.reason).toContain("locked track");
        const args = {
          projectId: f.project.id,
          composition,
          clipId: "card",
          expectedVersion: read.version,
          animationId: read.animations[0]!.id,
          change: { kind: "property", side: "to", name: "x", value: 200 },
        };
        expect(
          (await client.callTool({ name: "motion_update", arguments: args }))
            .isError,
        ).toBe(true);
        expect(await readFile(path, "utf8")).toBe(before);
        await setLock(false);
        const beforeAllowed = await readFile(path, "utf8");
        const state = await f.read(composition);
        expect(state.animations[0]!.reason).toBeNull();
        expect(
          (
            await client.callTool({
              name: "motion_update",
              arguments: {
                ...args,
                expectedVersion: state.version,
                animationId: state.animations[0]!.id,
              },
            })
          ).isError,
        ).not.toBe(true);
        expect(await readFile(path, "utf8")).toBe(
          beforeAllowed.replace("x:100", "x:200"),
        );
        expect((await f.request(`${f.base}/history/undo`, "POST")).ok).toBe(
          true,
        );
        expect(await readFile(path, "utf8")).toBe(beforeAllowed);
      } finally {
        await client.close();
        await server.close();
        await f.close();
      }
    }
  }
});
