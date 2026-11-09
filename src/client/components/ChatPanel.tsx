import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowUp,
  CaretDown,
  Check,
  Paperclip,
  Plus,
  Square,
  TerminalWindow,
  X,
} from "@phosphor-icons/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { z } from "zod";
import {
  agentCapabilitiesSchema,
  agentEventEnvelopeSchema,
  agentSessionSchema,
  type AgentCapabilities,
  type AgentMessage,
  type AgentProvider,
  type AgentRequest,
  type AgentSession,
  type AgentSkill,
} from "../../shared/agent";
import { api, json } from "../api";

const sessionListSchema = z.object({
  sessions: z.array(
    agentSessionSchema.omit({ messages: true, pendingRequest: true }),
  ),
});
const acceptedSchema = agentSessionSchema;
const draftSchema = z.object({
  version: z.literal(1),
  text: z.string(),
  attachments: z.array(z.string()),
});

function readDraft(projectId: string) {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(`cutroom:draft:${projectId}`) ?? "null",
    );
    return draftSchema.safeParse(value).data;
  } catch {
    return undefined;
  }
}

const Message = memo(function Message({
  message,
  provider,
}: {
  message: AgentMessage;
  provider: AgentProvider;
}) {
  if (message.role === "tool")
    return (
      <details className="chat-tool">
        <summary>{message.tool ?? "Tool"}</summary>
        <pre>{message.text}</pre>
      </details>
    );
  return (
    <article className={`chat-message message-${message.role}`}>
      <div className="message-byline">
        {message.role === "user"
          ? "You"
          : message.role === "assistant"
            ? provider === "codex"
              ? "Codex"
              : "Claude"
            : "Studio"}
      </div>
      <div className="markdown">
        <Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown>
      </div>
    </article>
  );
});

function RequestCard({
  request,
  onRespond,
}: {
  request: AgentRequest;
  onRespond: (
    decision: "allow" | "deny",
    answers?: Record<string, string | string[]>,
  ) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  async function respond(decision: "allow" | "deny") {
    setSending(true);
    setError("");
    try {
      await onRespond(decision, answers);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }
  return (
    <section
      className="agent-request"
      aria-label={
        request.kind === "question" ? "Agent question" : "Permission request"
      }
    >
      <strong>{request.title}</strong>
      {request.questions?.map((question) => (
        <fieldset key={question.id}>
          <legend>{question.question}</legend>
          {question.options.map((option) => (
            <label className="radio-row" key={option}>
              <input
                type={question.multiple ? "checkbox" : "radio"}
                name={question.id}
                checked={
                  Array.isArray(answers[question.id])
                    ? answers[question.id]?.includes(option)
                    : answers[question.id] === option
                }
                onChange={(event) =>
                  setAnswers((current) => {
                    if (!question.multiple)
                      return { ...current, [question.id]: option };
                    const value = current[question.id];
                    const selected = Array.isArray(value)
                      ? value
                      : value
                        ? [value]
                        : [];
                    return {
                      ...current,
                      [question.id]: event.target.checked
                        ? [...selected, option]
                        : selected.filter((item) => item !== option),
                    };
                  })
                }
              />
              {option}
            </label>
          ))}
          <input
            aria-label={`Answer: ${question.question}`}
            value={
              typeof answers[question.id] === "string"
                ? answers[question.id]
                : ""
            }
            onChange={(event) =>
              setAnswers({ ...answers, [question.id]: event.target.value })
            }
            placeholder="Write an answer"
          />
        </fieldset>
      ))}
      {request.kind === "approval" && (
        <details>
          <summary>{request.tool}</summary>
          <pre>{JSON.stringify(request.input, null, 2)}</pre>
        </details>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="request-actions">
        <button
          className="secondary-button"
          disabled={sending}
          onClick={() => void respond("deny")}
        >
          Decline
        </button>
        <button
          className="primary-button"
          disabled={sending}
          onClick={() => void respond("allow")}
        >
          <Check />
          {request.kind === "question" ? "Answer" : "Allow once"}
        </button>
      </div>
    </section>
  );
}

export function ChatPanel({
  projectId,
  visible,
  getContext,
  getReviewAttachments,
  onSent,
  prompt,
  onPromptConsumed,
  pickAttachment,
}: {
  projectId: string;
  visible: boolean;
  getContext: () => string;
  getReviewAttachments: () => string[];
  onSent: () => void;
  prompt: string | null;
  onPromptConsumed: () => void;
  pickAttachment: () => Promise<string | null>;
}) {
  const [provider, setProvider] = useState<AgentProvider>("codex");
  const [model, setModel] = useState("");
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(
    null,
  );
  const [discovering, setDiscovering] = useState(false);
  const [configurationRevision, setConfigurationRevision] = useState(0);
  const [sessions, setSessions] = useState<
    z.infer<typeof sessionListSchema>["sessions"]
  >([]);
  const [session, setSession] = useState<AgentSession | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState(() => readDraft(projectId)?.text ?? "");
  const [attachments, setAttachments] = useState<string[]>(
    () => readDraft(projectId)?.attachments ?? [],
  );
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [skillIndex, setSkillIndex] = useState(0);
  const [skillDismissed, setSkillDismissed] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const messages = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const pendingDraft = useRef({
    version: 1 as const,
    text: draft,
    attachments,
  });
  pendingDraft.current = { version: 1, text: draft, attachments };

  const saveDraft = useCallback(() => {
    try {
      const value = pendingDraft.current;
      const key = `cutroom:draft:${projectId}`;
      if (!value.text && !value.attachments.length)
        localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* Browser storage can be disabled; the open composer still works. */
    }
  }, [projectId]);

  useEffect(() => {
    const timer = setTimeout(saveDraft, 250);
    return () => clearTimeout(timer);
  }, [draft, attachments, saveDraft]);

  useEffect(() => {
    window.addEventListener("pagehide", saveDraft);
    return () => {
      saveDraft();
      window.removeEventListener("pagehide", saveDraft);
    };
  }, [saveDraft]);

  const loadSessions = useCallback(async () => {
    const result = await api(
      `/agents/sessions?projectId=${encodeURIComponent(projectId)}`,
      sessionListSchema,
    );
    setSessions(result.sessions);
    return result.sessions;
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    setSession(null);
    setSessionId(null);
    setError("");
    void loadSessions()
      .then((items) => {
        if (cancelled) return;
        const recent = items[0];
        if (recent) {
          setProvider(recent.provider);
          setModel(recent.model ?? "");
          setSessionId(recent.id);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [loadSessions]);

  useEffect(() => {
    let cancelled = false;
    setDiscovering(true);
    setCapabilities(null);
    void api(
      `/agents/capabilities?provider=${provider}&projectId=${encodeURIComponent(projectId)}${configurationRevision ? "&refresh=true" : ""}`,
      agentCapabilitiesSchema,
    )
      .then((result) => {
        if (!cancelled) setCapabilities(result);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setDiscovering(false);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, projectId, configurationRevision]);

  useEffect(() => {
    if (!sessionId) return;
    const source = new EventSource(
      `/api/cutroom/agents/sessions/${encodeURIComponent(sessionId)}/events`,
    );
    source.onmessage = (message) => {
      let value: unknown;
      try {
        value = JSON.parse(message.data);
      } catch {
        return;
      }
      const parsed = agentEventEnvelopeSchema.safeParse(value);
      if (!parsed.success) return;
      const event = parsed.data.event;
      if (event.type === "snapshot") setSession(event.session);
      if (event.type === "message")
        setSession((current) => {
          if (!current) return current;
          const index = current.messages.findIndex(
            (item) => item.id === event.message.id,
          );
          const items = [...current.messages];
          if (index < 0) items.push(event.message);
          else items[index] = event.message;
          return { ...current, messages: items };
        });
      if (event.type === "delta")
        setSession((current) =>
          current
            ? {
                ...current,
                messages: current.messages.map((item) =>
                  item.id === event.messageId
                    ? { ...item, text: item.text + event.text }
                    : item,
                ),
              }
            : current,
        );
      if (event.type === "status") {
        setSession((current) =>
          current ? { ...current, status: event.status } : current,
        );
        if (event.status === "idle" || event.status === "error")
          void loadSessions().catch(() => {});
      }
      if (event.type === "request")
        setSession((current) =>
          current ? { ...current, pendingRequest: event.request } : current,
        );
      if (event.type === "request-resolved")
        setSession((current) =>
          current ? { ...current, pendingRequest: undefined } : current,
        );
      if (event.type === "error") setError(event.message);
    };
    return () => source.close();
  }, [sessionId, loadSessions]);

  useEffect(() => {
    if (follow.current && messages.current)
      messages.current.scrollTop = messages.current.scrollHeight;
  }, [session?.messages, session?.pendingRequest]);

  useEffect(() => {
    if (!prompt) return;
    setDraft((value) => (value ? `${value}\n\n${prompt}` : prompt));
    textarea.current?.focus();
    onPromptConsumed();
  }, [prompt, onPromptConsumed]);

  const skillQuery = skillDismissed
    ? null
    : /\$([\w:/.-]*)$/.exec(
        draft.slice(0, textarea.current?.selectionStart ?? draft.length),
      );
  const skillResults = useMemo(() => {
    if (!skillQuery || !capabilities) return [];
    const query = skillQuery[1]?.toLowerCase() ?? "";
    return capabilities.skills
      .filter(
        (skill) =>
          skill.enabled &&
          `${skill.name} ${skill.description}`.toLowerCase().includes(query),
      )
      .slice(0, 12);
  }, [capabilities, skillQuery?.[1], Boolean(skillQuery)]);
  const busy = session?.status === "running" || session?.status === "waiting";

  function insertSkill(skill: AgentSkill) {
    const input = textarea.current;
    const caret = input?.selectionStart ?? draft.length;
    const before = draft
      .slice(0, caret)
      .replace(/\$[\w:/.-]*$/, `$${skill.name} `);
    setDraft(before + draft.slice(caret));
    setSkillDismissed(true);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(before.length, before.length);
    });
  }

  async function send() {
    if ((!draft.trim() && !attachments.length) || busy || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      let active = session;
      if (!active || active.provider !== provider) {
        active = await api(
          "/agents/sessions",
          agentSessionSchema,
          json("POST", { projectId, provider, ...(model ? { model } : {}) }),
        );
        setSession(active);
        setSessionId(active.id);
      }
      if (active.model !== (model || undefined)) {
        active = await api(
          `/agents/sessions/${active.id}`,
          agentSessionSchema,
          json("PATCH", { model: model || null }),
        );
        setSession(active);
        setModel(active.model ?? "");
      }
      const mentioned = new Set(
        [...draft.matchAll(/\$([\w:/.-]+)/g)].map((match) => match[1]),
      );
      const skills =
        capabilities?.skills
          .filter((skill) => skill.enabled && mentioned.has(skill.name))
          .map(({ name, path }) => ({ name, path })) ?? [];
      const files = [
        ...new Set([...attachments, ...getReviewAttachments()]),
      ].slice(0, 30);
      await api(
        `/agents/sessions/${active.id}/turns`,
        acceptedSchema,
        json("POST", {
          text: draft,
          skills,
          attachments: files.map((path) => ({ path })),
          context: getContext(),
        }),
      );
      setDraft("");
      setAttachments([]);
      follow.current = true;
      onSent();
      void loadSessions().catch(() => {});
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <aside className="chat-panel" aria-label="Agent chat" hidden={!visible}>
      <header className="panel-heading">
        <span className="panel-title">
          <TerminalWindow />
          Agent
        </span>
        <div className="heading-actions">
          <span className="quiet-label">
            {busy
              ? session?.status === "waiting"
                ? "Needs you"
                : "Working"
              : "Ready"}
          </span>
          <button
            className="icon-button"
            aria-label="Refresh agent configuration"
            disabled={busy || discovering}
            onClick={() => {
              setError("");
              setConfigurationRevision((value) => value + 1);
            }}
          >
            <ArrowClockwise />
          </button>
          <button
            className="icon-button"
            aria-label="New conversation"
            disabled={busy}
            onClick={() => {
              setSession(null);
              setSessionId(null);
              setError("");
              textarea.current?.focus();
            }}
          >
            <Plus />
          </button>
        </div>
      </header>
      <div className="chat-controls">
        <label className="select-label">
          <span className="sr-only">Agent provider</span>
          <select
            aria-label="Agent provider"
            value={provider}
            disabled={busy}
            onChange={(event) => {
              setProvider(event.target.value === "claude" ? "claude" : "codex");
              setModel("");
              setSession(null);
              setSessionId(null);
              setError("");
            }}
          >
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
          </select>
          <CaretDown size={12} />
        </label>
        <label className="select-label model-select">
          <span className="sr-only">Model</span>
          <select
            aria-label="Model"
            value={model}
            disabled={busy || discovering || submitting}
            onChange={(event) => {
              const selected = event.target.value;
              if (!session) {
                setModel(selected);
                return;
              }
              setSubmitting(true);
              void api(
                `/agents/sessions/${session.id}`,
                agentSessionSchema,
                json("PATCH", { model: selected || null }),
              )
                .then((result) => {
                  setSession(result);
                  setModel(result.model ?? "");
                })
                .catch((error: unknown) =>
                  setError(
                    error instanceof Error ? error.message : String(error),
                  ),
                )
                .finally(() => setSubmitting(false));
            }}
          >
            <option value="">Configured default</option>
            {capabilities?.models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <CaretDown size={12} />
        </label>
      </div>
      {sessions.length > 0 && (
        <select
          className="conversation-picker"
          aria-label="Conversation"
          value={sessionId ?? ""}
          disabled={busy}
          onChange={(event) => {
            setSession(null);
            setSessionId(event.target.value || null);
            const next = sessions.find(
              (item) => item.id === event.target.value,
            );
            if (next) {
              setProvider(next.provider);
              setModel(next.model ?? "");
            }
          }}
        >
          <option value="">New conversation</option>
          {sessions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
      )}
      <div
        className="chat-messages"
        ref={messages}
        onScroll={() => {
          const element = messages.current;
          if (element)
            follow.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              72;
        }}
      >
        {!session?.messages.length && (
          <div className="chat-empty">
            <div className="empty-agent-mark">
              <TerminalWindow size={26} weight="light" />
            </div>
            <h2>Keep the work in view.</h2>
            <p>
              Ask your agent to edit, or draw a change directly on the picture.
            </p>
            <p className="native-note">
              {discovering
                ? "Reading your agent configuration…"
                : capabilities?.available
                  ? `${capabilities.skills.filter((skill) => skill.enabled).length} native skills available. Type $ to choose one.`
                  : (capabilities?.error ??
                    "Choose an installed agent to begin.")}
            </p>
          </div>
        )}
        {session?.messages.map((message) => (
          <Message
            key={message.id}
            message={message}
            provider={session.provider}
          />
        ))}
        {session?.pendingRequest && (
          <RequestCard
            key={session.pendingRequest.id}
            request={session.pendingRequest}
            onRespond={async (decision, answers) => {
              await api(
                `/agents/sessions/${session.id}/responses`,
                acceptedSchema,
                json("POST", {
                  requestId: session.pendingRequest?.id,
                  decision,
                  answers,
                }),
              );
            }}
          />
        )}
      </div>
      {error && (
        <div className="chat-error" role="alert">
          <span>{error}</span>
          <button
            className="icon-button"
            aria-label="Dismiss agent error"
            onClick={() => setError("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <div className="composer-area">
        {skillResults.length > 0 && (
          <div className="skill-picker" role="listbox" aria-label="Skills">
            {skillResults.map((skill, index) => (
              <button
                key={`${skill.name}:${skill.path}`}
                role="option"
                aria-selected={index === skillIndex}
                className={index === skillIndex ? "selected" : ""}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertSkill(skill)}
              >
                <span>${skill.name}</span>
                <small>{skill.description}</small>
              </button>
            ))}
          </div>
        )}
        <div className="composer">
          {attachments.length > 0 && (
            <div className="attachment-list">
              {attachments.map((path) => (
                <span key={path}>
                  {path.split("/").at(-1)}
                  <button
                    aria-label={`Remove ${path.split("/").at(-1)}`}
                    onClick={() =>
                      setAttachments((items) =>
                        items.filter((item) => item !== path),
                      )
                    }
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={textarea}
            aria-label="Message your agent"
            placeholder="Describe the next edit…"
            value={draft}
            rows={3}
            onChange={(event) => {
              setDraft(event.target.value);
              setSkillIndex(0);
              setSkillDismissed(false);
            }}
            onKeyDown={(event) => {
              if (skillResults.length > 0) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setSkillIndex(
                    (index) =>
                      (index +
                        (event.key === "ArrowDown"
                          ? 1
                          : skillResults.length - 1)) %
                      skillResults.length,
                  );
                  return;
                }
                if (
                  (event.key === "Enter" || event.key === "Tab") &&
                  skillResults[skillIndex]
                ) {
                  event.preventDefault();
                  insertSkill(skillResults[skillIndex]);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSkillDismissed(true);
                  return;
                }
              }
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-footer">
            <div>
              <button
                className="icon-button"
                aria-label="Attach a file"
                onClick={() =>
                  void pickAttachment()
                    .then((path) => {
                      if (path)
                        setAttachments((items) => [
                          ...new Set([...items, path]),
                        ]);
                    })
                    .catch((error: unknown) =>
                      setError(
                        error instanceof Error ? error.message : String(error),
                      ),
                    )
                }
              >
                <Paperclip />
              </button>
              <span className="composer-hint">
                <kbd>$</kbd> skills
              </span>
            </div>
            {busy ? (
              <button
                className="send-button stop-button"
                aria-label="Stop agent"
                onClick={() =>
                  void api(
                    `/agents/sessions/${sessionId}/interrupt`,
                    acceptedSchema,
                    json("POST"),
                  ).catch((error: unknown) =>
                    setError(
                      error instanceof Error ? error.message : String(error),
                    ),
                  )
                }
              >
                <Square size={14} weight="fill" />
              </button>
            ) : (
              <button
                className="send-button"
                aria-label="Send message"
                disabled={
                  submitting ||
                  discovering ||
                  !capabilities?.available ||
                  (!draft.trim() && !attachments.length)
                }
                onClick={() => void send()}
              >
                <ArrowUp size={18} weight="bold" />
              </button>
            )}
          </div>
        </div>
        <div className="agent-footnote">
          {provider === "codex" ? "Codex" : "Claude Code"}
          {capabilities?.version ? ` ${capabilities.version}` : ""}
          <span>Shift Enter for a new line</span>
        </div>
      </div>
    </aside>
  );
}
