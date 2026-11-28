import { expect, test } from "bun:test";
import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileContentVersion } from "@hyperframes/studio-server";
import { AGENT_HEADER } from "../src/shared/review";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { projectFixture } from "./project-fixture";

for (const agent of [true, false])
  test(`${agent ? "agent" : "human"} source writes refuse permissions, instructions, and non-composition files`, async () => {
    const fixture = await projectFixture();
    const project = await fixture.store.create({ name: "Protected source" });
    const turn = await fixture.review.beginTurn(project, {
      kind: "message",
      id: "run",
      token: "agent",
    });
    const original = '{"original":true}';
    const blocked = [
      ".claude/settings.local.json",
      ".codex/config.toml",
      ".git/config",
      "CLAUDE.md",
      "AGENTS.md",
      "AGENTS.override.md",
      "GEMINI.md",
      ".mcp.json",
      "scenes/.private/data.json",
      "package.json",
      "mcp.json",
      "opencode.jsonc",
      "tsconfig.base.json",
      "CLAUDE.local.md",
      "vite.config.js",
      "script.sh",
      "notes.txt",
    ];
    try {
      for (const path of blocked) {
        await mkdir(dirname(join(project.path, path)), { recursive: true });
        await writeFile(join(project.path, path), original);
        const response = await fixture.app.request(
          `/api/cutroom/projects/${project.id}/source`,
          {
            method: "PUT",
            headers: {
              "content-type": "application/json",
              ...(agent && { [AGENT_HEADER]: "agent" }),
            },
            body: JSON.stringify({
              path,
              content: "changed",
              expectedVersion: fileContentVersion(original),
            }),
          },
        );
        expect(response.status, path).toBe(403);
        expect(await readFile(join(project.path, path), "utf8")).toBe(original);
      }
      await symlink(
        join(project.path, ".claude/settings.local.json"),
        join(project.path, "data.json"),
      );
      const alias = await fixture.app.request(
        `/api/cutroom/projects/${project.id}/source`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            ...(agent && { [AGENT_HEADER]: "agent" }),
          },
          body: JSON.stringify({
            path: "data.json",
            content: "changed",
            expectedVersion: fileContentVersion(original),
          }),
        },
      );
      expect(alias.status).toBe(403);
      expect(
        await readFile(
          join(project.path, ".claude/settings.local.json"),
          "utf8",
        ),
      ).toBe(original);
    } finally {
      await turn.end();
      await fixture.close();
    }
  });

test("HyperFrames' own file writers are not served, and uploads cannot reach protected paths", async () => {
  const fixture = await projectFixture();
  const project = await fixture.store.create({ name: "Upload boundary" });
  const editor = createHyperframesApi(fixture.store, fixture.review);
  fixture.app.route("/api/editor", editor);
  const original = "original";
  await mkdir(join(project.path, ".git"));
  await writeFile(join(project.path, ".git/config"), original);
  const routes = [
    ["PUT", "files/index.html", {}],
    ["POST", "files/.claude/settings.local.json", {}],
    ["PATCH", "files/index.html", { newPath: "CLAUDE.md" }],
    ["PATCH", "files/index.html", { newPath: "AGENTS.override.md" }],
    ["PATCH", "files/index.html", { newPath: ".claude/settings.local.json" }],
    ["DELETE", "files/.git/config", {}],
    ["POST", "file-mutations/remove-element/.git/config", {}],
    [
      "POST",
      "file-mutations/split-batch",
      { files: [{ path: ".git/config" }] },
    ],
    [
      "POST",
      "file-mutations/patch-element-batches",
      { batches: [{ sourceFile: ".git/config" }] },
    ],
    ["POST", "file-mutations/freeze-frame", { path: ".git/config" }],
    ["POST", "gsap-mutations/.git/config", {}],
    ["POST", "gsap-mutations-batch/.git/config", {}],
    [
      "POST",
      "gsap-mutation-rollback/.git/config",
      { expected: original, restore: "changed" },
    ],
    ["POST", "duplicate-file", { path: ".git/config" }],
    ["PUT", "files/%2egit/config", {}],
    ["PUT", "files/projects/fake/..%2f..%2f.git/config", {}],
    ["PUT", "files%2f.git%2fconfig/selection", {}],
    ["POST", "files%2fnotes/upload", {}],
    ["POST", "registry/install", { name: "lt-clean-bar" }],
    ["POST", "history/step", { direction: "back" }],
  ] as const;
  const index = await readFile(join(project.path, "index.html"), "utf8");
  try {
    for (const [method, route, body] of routes) {
      const response = await fixture.app.request(
        `/api/editor/projects/${project.id}/${route}`,
        {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      expect(response.status, route).toBe(404);
      expect(await readFile(join(project.path, ".git/config"), "utf8")).toBe(
        original,
      );
    }
    expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(
      index,
    );
    expect(await Bun.file(join(project.path, "notes")).exists()).toBe(false);
    const form = new FormData();
    form.append("file", new File(["permission"], "CLAUDE.md"));
    expect(
      (
        await fixture.app.request(`/api/editor/projects/${project.id}/upload`, {
          method: "POST",
          body: form,
        })
      ).status,
    ).toBe(403);
    const hidden = new FormData();
    hidden.append("file", new File(["{}"], "settings.local.json"));
    expect(
      (
        await fixture.app.request(
          `/api/editor/projects/${project.id}/upload?dir=.claude`,
          { method: "POST", body: hidden },
        )
      ).status,
    ).toBe(403);
    expect(await Bun.file(join(project.path, "CLAUDE.md")).exists()).toBe(
      false,
    );
    expect(
      await Bun.file(
        join(project.path, ".claude/settings.local.json"),
      ).exists(),
    ).toBe(false);
  } finally {
    await editor.dispose();
    await fixture.close();
  }
});

test("composition source types still save for the owner and an agent", async () => {
  const fixture = await projectFixture();
  const project = await fixture.store.create({ name: "Editable source" });
  const turn = await fixture.review.beginTurn(project, {
    kind: "message",
    id: "run",
    token: "agent",
  });
  try {
    for (const path of [
      "styles.css",
      "motion.js",
      "module.mjs",
      "scene.ts",
      "scene.tsx",
      "scene.jsx",
      "module.cjs",
      "data.json",
      "image.svg",
      "scene.htm",
    ]) {
      await writeFile(join(project.path, path), "original");
      for (const agent of [false, true]) {
        const before = await readFile(join(project.path, path), "utf8");
        const response = await fixture.app.request(
          `/api/cutroom/projects/${project.id}/source`,
          {
            method: "PUT",
            headers: {
              "content-type": "application/json",
              ...(agent && { [AGENT_HEADER]: "agent" }),
            },
            body: JSON.stringify({
              path,
              expectedVersion: fileContentVersion(before),
              content: `edited ${agent}`,
            }),
          },
        );
        expect(response.status, path).toBe(200);
        expect(await readFile(join(project.path, path), "utf8")).toBe(
          `edited ${agent}`,
        );
      }
    }
  } finally {
    await turn.end();
    await fixture.close();
  }
});

test("undo refuses to rewrite an instruction file", async () => {
  const fixture = await projectFixture();
  const project = await fixture.store.create({ name: "History boundary" });
  try {
    await writeFile(join(project.path, "CLAUDE.md"), "Original permissions");
    const history = await fixture.store.history(project);
    await writeFile(join(project.path, "CLAUDE.md"), "Updated permissions");
    await history.checkpoint();
    for (const [body, status, message] of [
      [{}, 200, '"entry":null'],
      [{ entryId: history.list().at(-1)?.id }, 403, "protected"],
    ] as const) {
      const response = await fixture.app.request(
        `/api/cutroom/projects/${project.id}/history/undo`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      expect(response.status, JSON.stringify(body)).toBe(status);
      expect(await response.text()).toContain(message);
    }
    expect(await readFile(join(project.path, "CLAUDE.md"), "utf8")).toBe(
      "Updated permissions",
    );
  } finally {
    await fixture.close();
  }
});

test("app metadata cannot be symlinked onto native permissions", async () => {
  const fixture = await projectFixture();
  const project = await fixture.store.create({ name: "Metadata alias" });
  try {
    const document = await fixture.store.document(project);
    const settings = JSON.stringify({
      ...document,
      permissions: { deny: ["Bash"] },
    });
    await mkdir(join(project.path, ".claude"));
    await writeFile(
      join(project.path, ".claude/settings.local.json"),
      settings,
    );
    await unlink(join(project.path, "cutroom.json"));
    await symlink(
      join(project.path, ".claude/settings.local.json"),
      join(project.path, "cutroom.json"),
    );
    const add = await fixture.request(
      `/projects/${project.id}/annotations`,
      "POST",
      { kind: "comment", body: "No permission changes", time: 0 },
    );
    expect(add.status).toBe(403);
    expect(
      await readFile(join(project.path, ".claude/settings.local.json"), "utf8"),
    ).toBe(settings);
  } finally {
    await fixture.close();
  }
});
