import type { Page } from "@playwright/test";
import type { AgentMessage, AgentSession } from "../src/shared/agent";

const cutroom = (name: string) => `mcp__cutroom_studio__${name}`;
const note = "“Speed up the lower third's slide-in and hold it…”";

/**
 * A recorded-shaped Claude turn that applies one review note: many lookups, one failed
 * command, one timeline edit, and a short reply. `steps` is every tool call in order.
 */
export function agentTurn(projectId: string) {
  const at = new Date().toISOString();
  let next = 0;
  const message = (
    role: AgentMessage["role"],
    text: string,
    extra: Partial<AgentMessage> = {},
  ): AgentMessage => ({
    id: `m${next++}`,
    role,
    text,
    createdAt: at,
    status: "complete",
    ...extra,
  });
  const tool = (name: string, target?: string, text = "{}") =>
    message("tool", text, { tool: name, ...(target && { target }) });
  const ask = message("user", "Apply my review note.");
  const plan = message(
    "assistant",
    "I'll check the review queue, speed up the lower third's slide-in, and extend its hold by one second.",
  );
  const failed = message(
    "tool",
    'Exit code 1\nnpm error npx canceled due to missing packages and no YES option: ["hyperframes@0.9.26"]\nnpm error A complete log of this run can be found in: /home/me/.npm/_logs/2026-11-11T14_46_47_000Z-debug-0.log',
    {
      tool: "Bash",
      target: "npx --no-install hyperframes validate",
      status: "failed",
    },
  );
  const edit = tool(cutroom("timeline_edit"), "Lower third");
  const steps = [
    tool(cutroom("review_list")),
    tool(cutroom("review_claim"), note),
    tool(cutroom("timeline_read")),
    ...[
      "index.html",
      "compositions/lower-third.html",
      "compositions/kicker.html",
      "styles/type.css",
      "scripts/motion.js",
      "assets/brand.json",
    ].map((path) => tool("Read", path, `<contents of ${path}>`)),
    tool("Bash", "ls compositions", "kicker.html\nlower-third.html"),
    failed,
    tool("Bash", "rg --files assets", "assets/brand.json\nassets/broll.mp4"),
    edit,
    ...[60, 69, 240].map((frame) =>
      tool(cutroom("timeline_view"), undefined, `Frame ${frame}`),
    ),
    tool(cutroom("review_complete"), note),
  ];
  const reply = message(
    "assistant",
    "Applied the note. The lower third slides in twice as fast, taking 0.3s, and holds for 6s instead of 5s.\n\nAutomated validation was unavailable because the HyperFrames CLI isn't installed locally.",
  );
  const session = (
    messages: AgentMessage[],
    status: AgentSession["status"],
  ): AgentSession => ({
    id: "00000000-0000-4000-8000-00000000a6e7",
    projectId,
    provider: "claude",
    title: "Apply my review note.",
    createdAt: at,
    updatedAt: at,
    status,
    messages,
  });
  return { ask, plan, steps, failed, edit, reply, session };
}

/**
 * Serves a conversation from fixed snapshots. Each stage is one reconnect of the event
 * stream, held until `advance` releases it, so a test steps through a streaming turn.
 */
export async function playSession(page: Page, stages: AgentSession[]) {
  const [first] = stages;
  if (!first) throw new Error("A played session needs at least one stage.");
  await page.route("**/api/cutroom/agents/capabilities?**", (route) =>
    route.fulfill({
      json: {
        provider: first.provider,
        available: true,
        skills: [],
        models: [],
        mcpServers: [],
      },
    }),
  );
  await page.route("**/api/cutroom/agents/sessions?**", (route) =>
    route.fulfill({ json: { sessions: [first] } }),
  );
  let connection = 0;
  const waiting: Array<() => void> = [];
  await page.route(
    `**/api/cutroom/agents/sessions/${first.id}/events`,
    async (route) => {
      const index = connection++;
      if (index > 0)
        await new Promise<void>((resolve) => waiting.push(resolve));
      const session = stages[Math.min(index, stages.length - 1)];
      const last = index >= stages.length - 1;
      await route
        .fulfill({
          contentType: "text/event-stream",
          body: `retry: ${last ? 600_000 : 20}\ndata: ${JSON.stringify({ seq: index, event: { type: "snapshot", session } })}\n\n`,
        })
        .catch(() => {});
    },
  );
  return {
    /** Delivers the next stage once the page has reconnected for it. */
    async advance() {
      while (!waiting.length)
        await new Promise((resolve) => setTimeout(resolve, 10));
      waiting.shift()?.();
    },
  };
}
