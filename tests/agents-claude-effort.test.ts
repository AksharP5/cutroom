import { expect, test } from "bun:test";
import { ClaudeRuntime, claudeModels } from "../src/server/agents/claude";

test("Claude reports the supported effort list in provider order", () => {
  expect(
    claudeModels([
      {
        value: "default",
        displayName: "Default",
        description: "Default",
        supportsEffort: true,
        supportedEffortLevels: ["high", "medium", "low"],
      },
      {
        value: "haiku",
        displayName: "Haiku",
        description: "Haiku",
        supportsEffort: false,
      },
    ]),
  ).toMatchObject([
    { id: "default", isDefault: true, efforts: ["high", "medium", "low"] },
    { id: "haiku", efforts: [] },
  ]);
});

test("Claude resumes the native session with the selected effort", async () => {
  const observed = Promise.withResolvers<unknown>();
  const runtime = new ClaudeRuntime(
    {
      cwd: "/projects/harbor",
      model: "opus",
      effort: "medium",
      nativeSessionId: "previous-session",
      agentToken: "test-token",
      emit: () => {},
      request: async ({ id }) => ({ requestId: id, decision: "deny" }),
    },
    {},
    ({ options }) => {
      observed.resolve(options);
      return {
        initializationResult: async () => {
          throw new Error("Synthetic query stopped at initialization.");
        },
        close: () => {},
        interrupt: async () => {},
        async *[Symbol.asyncIterator]() {},
      };
    },
  );
  try {
    await expect(
      runtime.send({ text: "Continue.", attachments: [], skills: [] }),
    ).rejects.toThrow("Synthetic query stopped at initialization.");
    expect(await observed.promise).toMatchObject({
      model: "opus",
      effort: "medium",
      resume: "previous-session",
    });
  } finally {
    runtime.dispose();
  }
});
