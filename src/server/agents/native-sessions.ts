import { z } from "zod";
import { agentProviderSchema } from "../../shared/agent";
import type { AgentMessage, AgentProvider } from "../../shared/agent";
import { HttpError } from "../../shared/errors";
import { CodexClient } from "./codex-client";
import {
  claudeTranscript,
  codexTranscript,
  codexTurnsSchema,
} from "./native-transcript";

export const nativeSessionInputSchema = z.object({
  provider: agentProviderSchema,
  sessionId: z.uuid(),
});
export type NativeSessionInput = z.infer<typeof nativeSessionInputSchema>;

const listLimit = 50;
const terminalCodexSources = ["cli", "exec"];
const providerNames = { claude: "Claude Code", codex: "Codex" };

type SessionMetadata = {
  id: string;
  title: string;
  updatedAt: string;
};
type ImportedSession = SessionMetadata & {
  messages: AgentMessage[];
  omittedMessages: number;
};

type NativeProvider = {
  list(cwd: string, excluded: ReadonlySet<string>): Promise<SessionMetadata[]>;
  open(
    cwd: string,
    id: string,
    mode: "continue" | "branch",
    owned: boolean,
  ): Promise<ImportedSession>;
};

const codexThreadSchema = z.object({
  id: z.uuid(),
  cwd: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  preview: z.string(),
  name: z.string().nullish(),
  source: z.unknown(),
});
const codexMetadata = z.object({ thread: codexThreadSchema });
const codexHistory = z.object({
  thread: codexThreadSchema.extend({ turns: codexTurnsSchema }),
});
const codexPage = z.object({
  data: z.array(codexThreadSchema),
  nextCursor: z.string().nullish(),
});
const accountSchema = z.object({
  account: z.unknown(),
  requiresOpenaiAuth: z.boolean(),
});
const claudeAuthSchema = z.object({
  loggedIn: z.boolean(),
  apiProvider: z.string().optional(),
});

function sessionTitle(value: string) {
  return value.trim().split(/\r?\n/, 1)[0]?.slice(0, 160) || "Untitled chat";
}

function missingSession(): never {
  throw new HttpError(
    404,
    "This native chat is no longer available in this project.",
  );
}

function codexSummary(thread: z.infer<typeof codexThreadSchema>) {
  return {
    id: thread.id,
    title: sessionTitle(thread.name || thread.preview),
    updatedAt: new Date(thread.updatedAt * 1000).toISOString(),
  };
}

const defaultCodexClient = (cwd: string) => new CodexClient({ cwd });
export function codexSessions(
  start: (
    cwd: string,
  ) => Pick<CodexClient, "call" | "dispose" | "exited"> = defaultCodexClient,
): NativeProvider {
  async function withCodex<T>(
    cwd: string,
    run: (client: Pick<CodexClient, "call">) => Promise<T>,
  ) {
    const client = start(cwd);
    try {
      const auth = accountSchema.parse(
        await client.call("account/read", { refreshToken: false }),
      );
      if (auth.requiresOpenaiAuth && !auth.account)
        throw new HttpError(503, "Sign in to Codex to see its chats.");
      return await run(client);
    } finally {
      client.dispose();
      await client.exited;
    }
  }
  return {
    list: (cwd, excluded) =>
      withCodex(cwd, async (client) => {
        const sessions: SessionMetadata[] = [];
        let cursor: string | null | undefined;
        do {
          const page = codexPage.parse(
            await client.call("thread/list", {
              cwd,
              sourceKinds: terminalCodexSources,
              sortKey: "updated_at",
              limit: listLimit,
              cursor,
            }),
          );
          for (const thread of page.data)
            if (!excluded.has(thread.id) && thread.cwd === cwd)
              sessions.push(codexSummary(thread));
          cursor = page.nextCursor;
        } while (sessions.length < listLimit && cursor);
        return sessions.slice(0, listLimit);
      }),
    open: (cwd, threadId, mode, owned) =>
      withCodex(cwd, async (client) => {
        const { thread: source } = codexMetadata.parse(
          await client
            .call("thread/read", { threadId, includeTurns: false })
            .catch((error: unknown) => {
              if (
                error instanceof Error &&
                /not found|no rollout/i.test(error.message)
              )
                missingSession();
              throw error;
            }),
        );
        if (
          source.cwd !== cwd ||
          (!owned && source.source !== "cli" && source.source !== "exec")
        )
          missingSession();

        // The fork holds a writer until this short-lived app-server closes.
        const { thread } = codexHistory.parse(
          mode === "branch"
            ? await client.call("thread/fork", {
                threadId,
                cwd,
                approvalPolicy: "on-request",
                sandbox: "workspace-write",
                excludeTurns: false,
              })
            : await client.call("thread/read", {
                threadId,
                includeTurns: true,
              }),
        );
        return {
          ...codexSummary(thread),
          ...codexTranscript(
            thread.turns,
            cwd,
            new Date(thread.createdAt * 1000).toISOString(),
          ),
        };
      }),
  };
}

async function claudeSdk(cwd: string) {
  const executable = Bun.which("claude");
  if (!executable) throw new HttpError(503, "Claude Code is not installed.");
  const auth = Bun.spawn([executable, "auth", "status", "--json"], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
    signal: AbortSignal.timeout(8_000),
  });
  const [raw] = await Promise.all([
    new Response(auth.stdout).text(),
    auth.exited,
  ]);
  const status = claudeAuthSchema.parse(JSON.parse(raw));
  if (
    !status.loggedIn &&
    (!status.apiProvider || status.apiProvider === "firstParty")
  )
    throw new HttpError(503, "Sign in to Claude Code to see its chats.");
  return import("@anthropic-ai/claude-agent-sdk");
}

const claudeSessions: NativeProvider = {
  async list(cwd, excluded) {
    const { listSessions } = await claudeSdk(cwd);
    const sessions: SessionMetadata[] = [];
    let offset = 0;
    while (sessions.length < listLimit) {
      const page = await listSessions({
        dir: cwd,
        limit: listLimit,
        offset,
        includeWorktrees: false,
        includeProgrammatic: false,
      });
      for (const session of page)
        if (
          !excluded.has(session.sessionId) &&
          (!session.cwd || session.cwd === cwd)
        )
          sessions.push({
            id: session.sessionId,
            title: sessionTitle(session.summary),
            updatedAt: new Date(session.lastModified).toISOString(),
          });
      if (page.length < listLimit) break;
      offset += page.length;
    }
    return sessions.slice(0, listLimit);
  },
  async open(cwd, id, mode) {
    const { getSessionInfo, getSessionMessages, forkSession } =
      await claudeSdk(cwd);
    const source = await getSessionInfo(id, { dir: cwd });
    if (!source || (source.cwd && source.cwd !== cwd)) missingSession();
    const sessionId =
      mode === "branch" ? (await forkSession(id, { dir: cwd })).sessionId : id;
    const history = await getSessionMessages(sessionId, { dir: cwd });
    return {
      id: sessionId,
      title: sessionTitle(source.summary),
      updatedAt: new Date(source.lastModified).toISOString(),
      ...claudeTranscript(
        history,
        cwd,
        new Date(source.createdAt ?? source.lastModified).toISOString(),
      ),
    };
  },
};

async function claudeLastModified(cwd: string, id: string) {
  const { getSessionInfo } = await import("@anthropic-ai/claude-agent-sdk");
  const info = await getSessionInfo(id, { dir: cwd });
  if (!info) missingSession();
  return info.lastModified;
}

function providerFailure(provider: AgentProvider, error: unknown) {
  if (error instanceof HttpError) return error;
  // Provider errors may contain paths or transcript content.
  if (error instanceof Error && "code" in error && error.code === "ENOENT")
    return new HttpError(503, `${providerNames[provider]} is not installed.`);
  return new HttpError(
    503,
    `Could not read ${providerNames[provider]} chats. Check that it is installed and signed in.`,
  );
}

export class NativeSessions {
  constructor(
    private readonly providers: Record<AgentProvider, NativeProvider> = {
      codex: codexSessions(),
      claude: claudeSessions,
    },
    private readonly lastModified = claudeLastModified,
  ) {}

  async list(
    cwd: string,
    excluded: Record<AgentProvider, ReadonlySet<string>>,
  ) {
    const results = await Promise.all(
      agentProviderSchema.options.map(async (provider) => {
        try {
          const sessions = await this.providers[provider].list(
            cwd,
            excluded[provider],
          );
          return {
            sessions: sessions.map((session) => ({ ...session, provider })),
          };
        } catch (error) {
          return {
            sessions: [],
            reason: {
              provider,
              reason: providerFailure(provider, error).message,
            },
          };
        }
      }),
    );
    return {
      sessions: results
        .flatMap(({ sessions }) => sessions)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      unavailable: results.flatMap(({ reason }) => (reason ? [reason] : [])),
    };
  }

  async open(
    cwd: string,
    { provider, sessionId }: NativeSessionInput,
    mode: "continue" | "branch",
    owned: boolean,
  ) {
    try {
      return await this.providers[provider].open(cwd, sessionId, mode, owned);
    } catch (error) {
      throw providerFailure(provider, error);
    }
  }

  async claudeChangedAt(cwd: string, id: string) {
    try {
      return await this.lastModified(cwd, id);
    } catch (error) {
      throw providerFailure("claude", error);
    }
  }
}
