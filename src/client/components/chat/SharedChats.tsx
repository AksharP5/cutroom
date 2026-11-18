import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  agentProviderSchema,
  agentSessionSchema,
  t3ThreadIdSchema,
} from "../../../shared/agent";
import type { AgentSessionSummary } from "../../../shared/agent";
import { api, json } from "../../api";
import { chatAge } from "./clock";

const threadsSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  threads: z.array(
    z.object({
      threadId: t3ThreadIdSchema,
      title: z.string(),
      status: z.string(),
      model: z.string(),
      updatedAt: z.iso.datetime(),
    }),
  ),
});

const nativeSessionsSchema = z.object({
  sessions: z.array(
    z.object({
      provider: agentProviderSchema,
      id: z.string(),
      title: z.string(),
      updatedAt: z.iso.datetime(),
    }),
  ),
  unavailable: z.array(
    z.object({ provider: agentProviderSchema, reason: z.string() }),
  ),
});

export function openNativeChat(
  projectId: string,
  mode: "continue" | "branch",
  provider: z.infer<typeof agentProviderSchema>,
  sessionId: string,
) {
  return api(
    `/projects/${encodeURIComponent(projectId)}/native-sessions/${mode}`,
    agentSessionSchema,
    json("POST", { provider, sessionId }),
  );
}

export type SharedChatView = "t3" | "native";
export const t3ThreadPageSize = 20;
type Listing =
  | { kind: "t3"; result: z.infer<typeof threadsSchema> }
  | { kind: "native"; result: z.infer<typeof nativeSessionsSchema> }
  | { kind: "error"; message: string };

export function SharedChats({
  mode,
  projectId,
  chats,
  onSelect,
  loadChats,
  threadQuery,
  threadLimit,
  onShowMore,
}: {
  mode: SharedChatView;
  projectId: string;
  chats: AgentSessionSummary[];
  onSelect: (chat: AgentSessionSummary) => void;
  loadChats: () => Promise<AgentSessionSummary[]>;
  threadQuery: string;
  threadLimit: number;
  onShowMore: (firstNewThread: string) => void;
}) {
  const [listing, setListing] = useState<Listing>();
  const [slow, setSlow] = useState(false);
  const [paste, setPaste] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const lifetime = useRef<AbortController>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const base = `/projects/${encodeURIComponent(projectId)}`;
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const { signal } = controller;
    const timer = setTimeout(() => setSlow(true), 300);
    const request =
      mode === "t3"
        ? api(`${base}/t3-threads`, threadsSchema, { signal }).then(
            (result): Listing => ({ kind: "t3", result }),
          )
        : api(`${base}/native-sessions`, nativeSessionsSchema, { signal }).then(
            (result): Listing => ({ kind: "native", result }),
          );
    void request
      .then((result) => {
        if (!signal.aborted) setListing(result);
      })
      .catch((error: unknown) => {
        if (!signal.aborted)
          setListing({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [base, mode]);

  const threads = listing?.kind === "t3" ? listing.result.threads : undefined;
  const linkedChats = useMemo(() => {
    const linked = new Map<string, AgentSessionSummary>();
    for (const chat of chats)
      if (chat.t3Thread && !linked.has(chat.t3Thread.threadId))
        linked.set(chat.t3Thread.threadId, chat);
    return linked;
  }, [chats]);
  const orderedThreads = useMemo(
    () =>
      threads?.toSorted(
        (a, b) =>
          Number(linkedChats.has(b.threadId)) -
            Number(linkedChats.has(a.threadId)) ||
          Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
      ),
    [threads, linkedChats],
  );
  const matchingThreads = useMemo(() => {
    const query = threadQuery.toLowerCase();
    return query
      ? orderedThreads?.filter((thread) =>
          thread.title.toLowerCase().includes(query),
        )
      : orderedThreads;
  }, [orderedThreads, threadQuery]);
  const firstHidden = matchingThreads?.[threadLimit];
  useLayoutEffect(() => {
    if (mode === "t3" && scroll.current) scroll.current.scrollTop = 0;
  }, [mode, threadQuery]);

  async function open(request: () => Promise<AgentSessionSummary>) {
    if (pending) return;
    const signal = lifetime.current?.signal;
    setPending(true);
    setError("");
    try {
      const chat = await request();
      void loadChats().catch(() => {});
      if (!signal?.aborted) onSelect(chat);
    } catch (error) {
      if (!signal?.aborted)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!signal?.aborted) setPending(false);
    }
  }

  function link(threadId: string) {
    const existing = linkedChats.get(threadId);
    if (existing) {
      onSelect(existing);
      return;
    }
    void open(() =>
      api(
        `${base}/t3-threads/link`,
        agentSessionSchema,
        json("POST", { threadId }),
      ),
    );
  }

  const now = Date.now();
  return (
    <>
      <div className="chat-list-scroll" ref={scroll}>
        {!listing && slow && (
          <p className="chat-list-message" role="status">
            {mode === "t3"
              ? "Looking in T3 Code"
              : "Looking for terminal chats"}
          </p>
        )}
        {listing?.kind === "error" && (
          <p className="chat-list-message" role="status">
            {listing.message}
          </p>
        )}
        {listing?.kind === "t3" && (
          <>
            {!listing.result.available ? (
              <p className="chat-list-message" role="status">
                {listing.result.reason ?? "T3 Code is unavailable."}
              </p>
            ) : !matchingThreads?.length ? (
              <p className="chat-list-message" role="status">
                {threadQuery
                  ? "No threads match."
                  : "No T3 Code threads for this folder."}
              </p>
            ) : null}
            {matchingThreads?.slice(0, threadLimit).map((thread) => {
              const linked = linkedChats.has(thread.threadId);
              const running = ["starting", "running", "queued"].includes(
                thread.status,
              );
              const status = running ? "running" : thread.status;
              return (
                <div className="chat-list-row" key={thread.threadId}>
                  <button
                    className="chat-list-pick"
                    type="button"
                    role="menuitem"
                    aria-label={thread.title}
                    aria-description={
                      [
                        status === "running"
                          ? "Working"
                          : status === "waiting"
                            ? "Needs you"
                            : "",
                        linked ? "Linked" : "",
                      ]
                        .filter(Boolean)
                        .join(", ") || undefined
                    }
                    data-menu-row={thread.threadId}
                    data-menu-label={thread.title}
                    tabIndex={-1}
                    aria-disabled={pending || undefined}
                    onClick={() => {
                      if (!pending) link(thread.threadId);
                    }}
                  >
                    <span className="chat-list-mark" data-status={status} />
                    <span className="chat-list-name" title={thread.title}>
                      {thread.title}
                    </span>
                    <span className="chat-list-meta chat-thread-meta">
                      <span title={thread.model}>{thread.model}</span>
                      {linked ? (
                        "Linked"
                      ) : (
                        <time className="mono" dateTime={thread.updatedAt}>
                          {chatAge(thread.updatedAt, now)}
                        </time>
                      )}
                    </span>
                  </button>
                </div>
              );
            })}
            {firstHidden && (
              <div className="chat-list-row">
                <button
                  className="chat-list-pick"
                  type="button"
                  role="menuitem"
                  data-menu-row=""
                  data-menu-label="Show 20 more"
                  tabIndex={-1}
                  onClick={() => onShowMore(firstHidden.threadId)}
                >
                  Show 20 more
                </button>
              </div>
            )}
          </>
        )}
        {listing?.kind === "native" && (
          <>
            {agentProviderSchema.options.map((provider) => {
              const label = provider === "codex" ? "Codex" : "Claude Code";
              const sessions = listing.result.sessions.filter(
                (session) => session.provider === provider,
              );
              const unavailable = listing.result.unavailable.find(
                (item) => item.provider === provider,
              );
              return (
                <div key={provider}>
                  {unavailable && (
                    <p className="chat-list-message" role="status">
                      {unavailable.reason}
                    </p>
                  )}
                  {sessions.length > 0 && (
                    <div
                      className="chat-list-group"
                      role="group"
                      aria-label={label}
                    >
                      <div className="quiet-label" aria-hidden="true">
                        {label}
                      </div>
                      {sessions.map((session) => (
                        <div
                          className="chat-list-row chat-native-row"
                          key={session.id}
                        >
                          <button
                            className="chat-list-pick"
                            type="button"
                            role="menuitem"
                            aria-label={session.title}
                            data-menu-row={session.id}
                            data-menu-label={session.title}
                            tabIndex={-1}
                            aria-disabled={pending || undefined}
                            onClick={() =>
                              void open(() =>
                                openNativeChat(
                                  projectId,
                                  "continue",
                                  provider,
                                  session.id,
                                ),
                              )
                            }
                          >
                            <span
                              className="chat-list-name"
                              title={session.title}
                            >
                              {session.title}
                            </span>
                            <span className="chat-list-meta">
                              <time
                                className="mono"
                                dateTime={session.updatedAt}
                              >
                                {chatAge(session.updatedAt, now)}
                              </time>
                            </span>
                          </button>
                          <button
                            className="chat-list-branch text-button"
                            type="button"
                            role="menuitem"
                            aria-keyshortcuts="B"
                            disabled={pending}
                            onClick={() =>
                              void open(() =>
                                openNativeChat(
                                  projectId,
                                  "branch",
                                  provider,
                                  session.id,
                                ),
                              )
                            }
                          >
                            Branch
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {!listing.result.sessions.length && (
              <p className="chat-list-message" role="status">
                No Codex or Claude Code chats for this folder.
              </p>
            )}
          </>
        )}
      </div>
      {mode === "t3" && (
        <form
          className="chat-link-field"
          onSubmit={(event) => {
            event.preventDefault();
            if (!pending && paste.trim()) link(paste.trim());
          }}
        >
          <input
            aria-label="Paste a thread ID"
            placeholder="Paste a thread ID"
            value={paste}
            onChange={(event) => setPaste(event.target.value)}
          />
          <button
            type="submit"
            className="text-button"
            disabled={pending || !paste.trim()}
          >
            Link
          </button>
        </form>
      )}
      {error && (
        <p className="chat-list-message" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
