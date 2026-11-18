import { expect, test } from "bun:test";
import type {
  Options,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk/core";
import { ClaudeRuntime } from "../src/server/agents/claude";

test.each([undefined, "previous-session"])(
  "Claude sends standing instructions and keeps turn content separate (resume: %s)",
  async (nativeSessionId) => {
    const queries: Options[] = [];
    const messages: SDKUserMessage[] = [];
    const cwd = "/projects/harbor";
    const runtime = new ClaudeRuntime(
      {
        cwd,
        nativeSessionId,
        agentToken: "test-token",
        emit: () => {},
        request: async ({ id }) => ({ requestId: id, decision: "deny" }),
      },
      {},
      ({ prompt, options }) => {
        queries.push(options);
        return {
          initializationResult: async () => ({
            commands: [],
            agents: [],
            output_style: "",
            available_output_styles: [],
            models: [],
            account: {},
          }),
          close: () => {},
          interrupt: async () => {},
          async *[Symbol.asyncIterator]() {
            for await (const message of prompt) {
              messages.push(message);
              yield {
                type: "result",
                subtype: "success",
                session_id: "test-session",
                uuid: crypto.randomUUID(),
                duration_ms: 1,
                duration_api_ms: 1,
                is_error: false,
                num_turns: 1,
                result: "",
                stop_reason: "end_turn",
                total_cost_usd: 0,
                usage: {
                  cache_creation: {
                    ephemeral_5m_input_tokens: 0,
                    ephemeral_1h_input_tokens: 0,
                  },
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                  fallback_credit: null,
                  inference_geo: "",
                  input_tokens: 0,
                  iterations: [],
                  output_tokens: 0,
                  output_tokens_details: { thinking_tokens: 0 },
                  server_tool_use: {
                    web_search_requests: 0,
                    web_fetch_requests: 0,
                  },
                  service_tier: "standard",
                  speed: "standard",
                },
                modelUsage: {},
                permission_denials: [],
              };
            }
          },
        };
      },
    );
    try {
      await runtime.send({
        text: "Animate the title.",
        context: "Playhead at 2 seconds",
        attachments: [
          { path: "/projects/harbor/notes.txt", mimeType: "text/plain" },
        ],
        skills: [],
      });
      await runtime.send({ text: "Thanks.", attachments: [], skills: [] });
      expect(queries).toHaveLength(1);
      expect(queries[0]?.resume).toBe(nativeSessionId);
      const prompt = queries[0]?.systemPrompt;
      if (!prompt || typeof prompt !== "object" || !("preset" in prompt))
        throw new Error("Expected the Claude Code preset.");
      expect(prompt.preset).toBe("claude_code");
      expect(prompt.snapshot).toBe(false);
      expect(prompt.append).toContain(cwd);
      expect(prompt.append).toContain(
        "load relevant installed HyperFrames skills",
      );
      expect(messages.map(({ message }) => message.content)).toEqual([
        [
          {
            type: "text",
            text: "Animate the title.\n\n<cutroom-context>\nPlayhead at 2 seconds\n</cutroom-context>\n\nAttached local files:\n/projects/harbor/notes.txt",
          },
        ],
        [{ type: "text", text: "Thanks." }],
      ]);
    } finally {
      runtime.dispose();
    }
  },
);
