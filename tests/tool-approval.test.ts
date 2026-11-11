import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { toolApproval } from "../src/server/agents/tool-approval";
import { cutroomToolRegistry } from "../src/server/agents/tool-permissions";
import { toolCalls } from "../src/server/agents/runtime";
import {
  projectNames,
  quoteNote,
  toolSubject,
} from "../src/server/agents/tool-subject";
import type { ToolNames } from "../src/server/agents/tool-subject";
import { addAnnotation } from "../src/server/projects/review";
import type { Project } from "../src/shared/project";
import { describedCutroomTools } from "../src/shared/toolRow";
import { projectFixture } from "./project-fixture";

const tool = (name: string) => `mcp__cutroom_studio__${name}`;
let fixture: Awaited<ReturnType<typeof projectFixture>>;
let project: Project;
let names: ToolNames;
let noteId: string;

beforeAll(async () => {
  fixture = await projectFixture();
  project = await fixture.store.create({ name: "Launch cut" });
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><body><main data-composition-id="main" data-width="320" data-height="240" data-duration="12">
<div id="lt-7f3a" class="clip" data-start="0" data-duration="5" data-track-index="1" data-label="Lower third"></div>
<div id="kicker-9c1e" class="clip" data-start="5" data-duration="3" data-track-index="2" data-label="Kicker"></div>
<video id="broll-2b8d" class="clip" src="assets/broll.mp4" data-start="0" data-duration="8" data-track-index="0" muted></video>
</main></body></html>`,
  );
  noteId = (
    await addAnnotation(fixture.store, project, {
      kind: "comment",
      compositionPath: "index.html",
      body: "Speed up the lower third's slide-in and hold it for a second longer, please.",
      time: 2,
      strokes: [],
    })
  ).id;
  names = projectNames(fixture.store, fixture.review, project);
});
afterAll(() => fixture.close());

test("an approval names the note, clips, or file, and never an id or tool identifier", async () => {
  const claim = await toolApproval(
    tool("review_claim"),
    { projectId: project.id, noteId },
    project.path,
    names,
  );
  expect(claim.title).toBe(
    "Start “Speed up the lower third's slide-in and hold it…”?",
  );
  const withdraw = await toolApproval(
    tool("review_withdraw"),
    { projectId: project.id, noteId, reason: "The owner dropped this." },
    project.path,
    names,
  );
  expect(withdraw).toMatchObject({
    title: "Withdraw “Speed up the lower third's slide-in and hold it…”?",
    detail: "The owner dropped this.",
  });
  const edit = await toolApproval(
    tool("timeline_edit"),
    {
      projectId: project.id,
      expectedRevision: "revision",
      noteId,
      commands: [
        { type: "trim", clipId: "lt-7f3a", edge: "end", to: 180 },
        { type: "setClip", clipId: "lt-7f3a", fadeIn: 9 },
        { type: "move", clipIds: ["kicker-9c1e"], by: 30 },
      ],
    },
    project.path,
    names,
  );
  expect(edit).toMatchObject({
    title: "Edit Lower third and Kicker?",
    detail: "3 changes",
  });
  // Media is named by its file, and a clip the timeline cannot name is only counted.
  expect(
    (
      await toolApproval(
        tool("timeline_edit"),
        {
          projectId: project.id,
          expectedRevision: "revision",
          commands: [
            {
              type: "remove",
              clipIds: ["broll-2b8d", "lt-7f3a", "kicker-9c1e", "gone-1"],
            },
          ],
        },
        project.path,
        names,
      )
    ).title,
  ).toBe("Edit broll.mp4 and 3 more clips?");
  const whole = await toolApproval(
    tool("timeline_edit"),
    {
      projectId: project.id,
      expectedRevision: "revision",
      commands: [{ type: "split", at: 90 }],
    },
    project.path,
    names,
  );
  expect(whole.title).toBe("Edit the timeline?");
  expect(whole.detail).toBeUndefined();
  const exported = await toolApproval(
    tool("export_start"),
    {
      projectId: project.id,
      filename: "Final.mp4",
      directory: "/home/me/Videos",
    },
    project.path,
    names,
  );
  expect(exported).toMatchObject({
    title: "Start an export?",
    detail: "Final.mp4 in /home/me/Videos",
  });
  for (const approval of [claim, withdraw, edit, whole, exported]) {
    const shown = `${approval.title} ${approval.detail ?? ""}`;
    expect(shown).not.toContain(noteId);
    expect(shown).not.toContain(project.id);
    expect(shown).not.toMatch(/mcp__|cutroom_studio|lt-7f3a|kicker-9c1e/);
  }
});

test("native and outside tools ask in plain words", async () => {
  expect(
    await toolApproval(
      "Bash",
      { command: `ls ${project.path}/assets && rm -rf /tmp/scratch` },
      project.path,
    ),
  ).toMatchObject({
    title: "Run this command?",
    target: `ls ${project.path}/assets && rm -rf /tmp/scratch`,
  });
  expect(
    (
      await toolApproval(
        "Edit",
        { file_path: `${project.path}/compositions/intro.html` },
        project.path,
      )
    ).title,
  ).toBe("Edit compositions/intro.html?");
  // A file outside the project keeps its whole path, so nothing is misattributed.
  expect(
    (await toolApproval("Write", { file_path: "/etc/hosts" }, project.path))
      .title,
  ).toBe("Write /etc/hosts?");
  // Another server's tool is named with its server and never reads as Cutroom's own.
  expect(
    (await toolApproval("mcp__other__timeline_edit", {}, project.path)).title,
  ).toBe("Edit timeline from other?");
  expect(
    (await toolApproval("mcp__github__create_issue", {}, project.path)).title,
  ).toBe("Use create issue from github?");
});

test("a transcript row and its approval name the same thing, from the project as it is", async () => {
  const input = {
    projectId: project.id,
    expectedRevision: "revision",
    composition: "index.html",
    // A stray path-like key must never become the name of a Cutroom call.
    file_path: "/etc/passwd",
    commands: [{ type: "setClip", clipId: "lt-7f3a", fadeIn: 9 }],
  };
  const subject = await toolSubject(
    "cutroom_studio: timeline_edit",
    input,
    names,
  );
  expect(subject).toBe("Lower third");
  const calls = toolCalls(project.path);
  expect(calls.start("a", tool("timeline_edit"), input, subject).target).toBe(
    "Lower third",
  );
  expect(calls.finish("a", "{}", false).target).toBe("Lower third");
  expect(calls.start("b", tool("timeline_edit"), input).target).toBeUndefined();
  // Without a project to read, the call still describes itself without ids.
  expect(await toolSubject(tool("timeline_edit"), input)).toBeUndefined();
  expect(
    await toolSubject(tool("review_claim"), { noteId: "missing" }, names),
  ).toBeUndefined();
  expect(
    await toolSubject("mcp__other__review_claim", { noteId }, names),
  ).toBeUndefined();
  expect(quoteNote("  Fix   the\ncolor ")).toBe("“Fix the color”");
  expect(quoteNote("")).toBeUndefined();
});

test("every Cutroom tool has its own wording", () => {
  expect(describedCutroomTools.toSorted()).toEqual(
    [...cutroomToolRegistry.keys()].toSorted(),
  );
});
