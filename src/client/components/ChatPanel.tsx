import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";
import {
  ArrowClockwise,
  ArrowUp,
  CaretDown,
  CaretRight,
  Paperclip,
  Plus,
  Square,
  X,
} from "@phosphor-icons/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { z } from "zod";
import {
  agentPermissionsSchema,
  agentCapabilitiesSchema,
  agentEventEnvelopeSchema,
  agentSessionSchema,
  type AgentCapabilities,
  type AgentEvent,
  type AgentMessage,
  type AgentProvider,
  type AgentRequest,
  type AgentSession,
  type AgentSkill,
} from "../../shared/agent";
import { api, json } from "../api";
import {
  describeTool,
  editsProject,
  failureReason,
  hiddenTools,
  runsCommand,
  summarizeSteps,
  targetsFile,
} from "../../shared/toolRow";
import { useWorkspace } from "../workspace";
import { SelectMenu } from "./SelectMenu";
import { waitForNoteCaptures } from "../edit/noteStore";

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

type ConversationState =
  | { phase: "restoring" }
  | { phase: "new" }
  | { phase: "loading"; id: string }
  | { phase: "ready"; session: AgentSession };
type TurnSubmission = { kind: "turn"; stopped: boolean; sessionId?: string };
type ChatOperation = TurnSubmission | { kind: "model" } | { kind: "stop" };

function applyConversationEvents(
  state: ConversationState,
  id: string,
  events: AgentEvent[],
): ConversationState {
  if (state.phase === "new" || state.phase === "restoring") return state;
  if ((state.phase === "ready" ? state.session.id : state.id) !== id)
    return state;
  let session = state.phase === "ready" ? state.session : null;
  for (const event of events) {
    if (event.type === "snapshot") {
      if (event.session.id === id) session = event.session;
      continue;
    }
    if (!session) continue;
    if (event.type === "message" || event.type === "delta") {
      const messageId =
        event.type === "message" ? event.message.id : event.messageId;
      const index = session.messages.findIndex((item) => item.id === messageId);
      const items = [...session.messages];
      if (event.type === "message") {
        if (index < 0) items.push(event.message);
        else items[index] = event.message;
      } else {
        const message = items[index];
        if (!message) continue;
        items[index] = { ...message, text: message.text + event.text };
      }
      session = { ...session, messages: items };
    }
    if (event.type === "status") session = { ...session, status: event.status };
    if (event.type === "request")
      session = { ...session, pendingRequest: event.request };
    if (event.type === "request-resolved")
      session = { ...session, pendingRequest: undefined };
  }
  return session ? { phase: "ready", session } : state;
}

const ToolRow = memo(function ToolRow({ message }: { message: AgentMessage }) {
  const { verb, object } = describeTool(
    message,
    message.status === "streaming" ? "active" : "done",
  );
  const reason = message.status === "failed" ? failureReason(message) : "";
  return (
    <div
      className="chat-step"
      data-status={message.status}
      data-edit={editsProject(message.tool) || undefined}
    >
      <details className="chat-tool" data-status={message.status}>
        <summary title={`${verb} ${object}`.trim()}>
          {message.status === "streaming" ? (
            <span className="chat-tool-now" />
          ) : (
            <CaretRight className="chat-tool-caret" size={10} weight="bold" />
          )}
          {/* The spaces are for screen readers and copying; the grid ignores them. */}
          <span className="chat-tool-verb">{verb}</span>{" "}
          {/* Long file paths lose their start, so the file name stays visible. */}
          <span
            className="chat-tool-target"
            data-path={targetsFile(message.tool) || undefined}
          >
            <bdi>{object}</bdi>
          </span>{" "}
          {message.status === "failed" && (
            <span className="chat-tool-note">Failed</span>
          )}
        </summary>
        <pre>{message.text}</pre>
      </details>
      {/* A failure says why without being opened; the open row shows the whole output. */}
      {reason && <p className="chat-tool-reason">{reason}</p>}
    </div>
  );
});

/**
 * One turn segment's tool calls. Routine steps fold into a single summary line whose counts
 * grow in place while the turn runs; failures and project edits keep their own rows.
 */
function StepGroup({ steps }: { steps: AgentMessage[] }) {
  const [open, setOpen] = useState(false);
  const rows = useId();
  const { summary, running, shown } = summarizeSteps(steps);
  return (
    <div className="chat-tools" role="group" aria-label="Agent steps">
      {summary && (
        <button
          type="button"
          className="chat-steps"
          data-running={running || undefined}
          aria-expanded={open}
          aria-controls={rows}
          title={summary}
          onClick={() => setOpen((value) => !value)}
        >
          {running ? (
            <span className="chat-tool-now" />
          ) : (
            <CaretRight className="chat-tool-caret" size={10} weight="bold" />
          )}
          <span className="chat-steps-summary">{summary}</span>
        </button>
      )}
      <div id={rows}>
        {(open || !summary ? steps : shown).map((message) => (
          <ToolRow key={message.id} message={message} />
        ))}
      </div>
    </div>
  );
}

const Message = memo(function Message({
  message,
  provider,
}: {
  message: AgentMessage;
  provider: AgentProvider;
}) {
  return (
    <article className={`chat-message message-${message.role}`}>
      <div className="sr-only">
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
    alwaysAllowCutroomEdits?: boolean,
  ) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [showInput, setShowInput] = useState(false);
  const title = useId();
  const raw = useId();
  async function respond(decision: "allow" | "deny", always = false) {
    setSending(true);
    setError("");
    try {
      await onRespond(decision, answers, always);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }
  const question = request.kind === "question";
  const decide = (
    <>
      <button
        className={question ? "text-button" : "secondary-button"}
        disabled={sending}
        onClick={() => void respond("allow")}
      >
        {question ? "Answer" : "Allow once"}
      </button>
      <button
        className="text-button quiet"
        disabled={sending}
        onClick={() => void respond("deny")}
      >
        {question ? "Decline" : "Deny"}
      </button>
    </>
  );
  return (
    <section
      className="agent-request"
      aria-label={
        request.kind === "question" ? "Agent question" : "Permission request"
      }
      aria-describedby={request.kind === "approval" ? title : undefined}
    >
      {request.kind === "approval" ? (
        <>
          <p className="agent-request-title" id={title}>
            {request.title}
          </p>
          {/* A command is the thing being approved, so it is read in full. */}
          {runsCommand(request.tool) && request.target && (
            <pre className="agent-request-command">{request.target}</pre>
          )}
          {request.detail && (
            <p className="agent-request-detail">{request.detail}</p>
          )}
          <div className="agent-request-actions">
            {decide}
            <button
              className="text-button quiet agent-request-more"
              aria-expanded={showInput}
              aria-controls={raw}
              onClick={() => setShowInput((value) => !value)}
            >
              Details
            </button>
          </div>
          {/* The lasting grant reads as one sentence with everything it covers. */}
          {request.canAllowCutroomEdits && (
            <p className="agent-request-scope">
              <button
                className="text-button"
                disabled={sending}
                onClick={() => void respond("allow", true)}
              >
                Always allow Cutroom edits
              </button>{" "}
              for this project, in every conversation, until you revoke. Shell
              and native file changes still ask.
            </p>
          )}
          {/* The exact request stays one click away for anyone who wants to check it. */}
          {showInput && (
            <pre id={raw}>
              {`${request.tool}\n${JSON.stringify(request.input, null, 2)}`}
            </pre>
          )}
        </>
      ) : (
        <strong className="agent-question-title">{request.title}</strong>
      )}
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
      {request.kind === "question" && (
        <div className="agent-question-actions">{decide}</div>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

const ConversationMessages = memo(function ConversationMessages({
  session,
  capabilities,
  discovering,
  messagesRef,
  followRef,
  onRespond,
}: {
  session: AgentSession | null;
  capabilities: AgentCapabilities | null;
  discovering: boolean;
  messagesRef: RefObject<HTMLDivElement | null>;
  followRef: RefObject<boolean>;
  onRespond: (
    decision: "allow" | "deny",
    answers?: Record<string, string | string[]>,
    alwaysAllowCutroomEdits?: boolean,
  ) => Promise<void>;
}) {
  // Consecutive tool calls read as one step group. Empty replies and tool
  // lookups say nothing, so they neither show nor split a group.
  const blocks: AgentMessage[][] = [];
  for (const message of session?.messages ?? []) {
    if (message.role === "tool" && hiddenTools.has(message.tool ?? ""))
      continue;
    if (message.role !== "tool" && !message.text.trim()) continue;
    const last = blocks.at(-1);
    if (message.role === "tool" && last?.[0]?.role === "tool")
      last.push(message);
    else blocks.push([message]);
  }
  return (
    <div
      className="chat-messages"
      ref={messagesRef}
      onScroll={() => {
        const element = messagesRef.current;
        if (element)
          followRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            72;
      }}
    >
      {!session?.messages.length && (
        <div className="chat-empty">
          <h2>What should we change?</h2>
          <p>Describe an edit, or draw on the preview to show your agent.</p>
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
      {session &&
        blocks.map((block) =>
          block[0]?.role === "tool" ? (
            <StepGroup key={block[0].id} steps={block} />
          ) : (
            block.map((message) => (
              <Message
                key={message.id}
                message={message}
                provider={session.provider}
              />
            ))
          ),
        )}
      {session?.pendingRequest?.kind === "question" && (
        <RequestCard
          key={session.pendingRequest.id}
          request={session.pendingRequest}
          onRespond={onRespond}
        />
      )}
    </div>
  );
});

/** Elapsed agent time as a clock (m:ss), not timecode. Re-renders only itself. */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  return (
    <span className="presence-clock mono">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
    </span>
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
  workingNote,
}: {
  projectId: string;
  visible: boolean;
  getContext: () => string;
  getReviewAttachments: () => Promise<string[]>;
  onSent: () => void;
  prompt: string | null;
  onPromptConsumed: () => void;
  pickAttachment: () => Promise<string | null>;
  /** The number, as in Review, of the note the agent has claimed. */
  workingNote: number | null;
}) {
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void api(`/projects/${projectId}/agent-permissions`, agentPermissionsSchema)
      .then((value) => {
        if (!cancelled) setAlwaysAllow(value.alwaysAllowCutroomEdits);
      })
      .catch((error) => {
        if (!cancelled) setError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);
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
  const [conversation, setConversation] = useState<ConversationState>({
    phase: "restoring",
  });
  const session = conversation.phase === "ready" ? conversation.session : null;
  const sessionId =
    conversation.phase === "ready"
      ? conversation.session.id
      : conversation.phase === "loading"
        ? conversation.id
        : null;
  const opening =
    conversation.phase === "restoring" || conversation.phase === "loading";
  const [draft, setDraft] = useState(() => readDraft(projectId)?.text ?? "");
  const [attachments, setAttachments] = useState<string[]>(
    () => readDraft(projectId)?.attachments ?? [],
  );
  const [error, setError] = useState("");
  const [operation, setOperation] = useState<ChatOperation | null>(null);
  const submitting = operation !== null;
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
    setConversation({ phase: "restoring" });
    setError("");
    void loadSessions()
      .then((items) => {
        if (cancelled) return;
        const recent = items[0];
        if (recent) {
          setProvider(recent.provider);
          setModel(recent.model ?? "");
          setConversation({ phase: "loading", id: recent.id });
        } else setConversation({ phase: "new" });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setConversation({ phase: "new" });
          setError(error instanceof Error ? error.message : String(error));
        }
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
    useWorkspace.setState({
      agent: capabilities && {
        name: capabilities.provider === "codex" ? "Codex" : "Claude Code",
        available: capabilities.available,
      },
    });
  }, [capabilities]);
  useEffect(() => () => useWorkspace.setState({ agent: null }), []);

  useEffect(() => {
    if (!sessionId) return;
    const source = new EventSource(
      `/api/cutroom/agents/sessions/${encodeURIComponent(sessionId)}/events`,
    );
    let pending: AgentEvent[] = [];
    let frame: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const flush = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      clearTimeout(timer);
      frame = undefined;
      timer = undefined;
      if (closed || !pending.length) return;
      const events = pending;
      pending = [];
      setConversation((current) =>
        applyConversationEvents(current, sessionId, events),
      );
      for (const event of events)
        if (event.type === "error") setError(event.message);
      if (
        events.some(
          (event) =>
            event.type === "status" &&
            (event.status === "idle" || event.status === "error"),
        )
      )
        void loadSessions().catch(() => {});
    };
    source.onmessage = (message) => {
      if (closed) return;
      let value: unknown;
      try {
        value = JSON.parse(message.data);
      } catch {
        return;
      }
      const parsed = agentEventEnvelopeSchema.safeParse(value);
      if (!parsed.success) return;
      const event = parsed.data.event;
      const previous = pending.at(-1);
      if (
        event.type === "delta" &&
        previous?.type === "delta" &&
        previous.messageId === event.messageId
      )
        pending[pending.length - 1] = {
          ...previous,
          text: previous.text + event.text,
        };
      else pending.push(event);
      if (frame !== undefined) return;
      frame = requestAnimationFrame(flush);
      // Background windows can suspend animation frames; still consume native output.
      timer = setTimeout(flush, 50);
    };
    return () => {
      closed = true;
      source.close();
      pending = [];
      if (frame !== undefined) cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [sessionId, loadSessions]);

  // A new question always comes into view; it is waiting on you.
  const pendingQuestion =
    session?.pendingRequest?.kind === "question"
      ? session.pendingRequest.id
      : null;
  useEffect(() => {
    if (pendingQuestion) follow.current = true;
  }, [pendingQuestion]);
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
  const requestId = session?.pendingRequest?.id;
  const respondToRequest = useCallback(
    async (
      decision: "allow" | "deny",
      answers?: Record<string, string | string[]>,
      alwaysAllowCutroomEdits?: boolean,
    ) => {
      if (!sessionId || !requestId)
        throw new Error("This request is no longer active.");
      await api(
        `/agents/sessions/${sessionId}/responses`,
        acceptedSchema,
        json("POST", { requestId, decision, answers, alwaysAllowCutroomEdits }),
      );
      if (alwaysAllowCutroomEdits) setAlwaysAllow(true);
    },
    [sessionId, requestId],
  );
  const busy = session?.status === "running" || session?.status === "waiting";
  const controlsLocked = busy || submitting || opening;
  const active =
    busy || operation?.kind === "turn" || operation?.kind === "stop";
  // A turn starts with the owner's latest message.
  const turnStart = session?.messages.findLast(
    (message) => message.role === "user",
  )?.createdAt;

  async function stop() {
    const pending = operation?.kind === "turn" ? operation : null;
    if (pending) pending.stopped = true;
    const id = pending?.sessionId ?? sessionId;
    if (!id) {
      setOperation((current) => (current === pending ? null : current));
      return;
    }
    const stopping: ChatOperation = { kind: "stop" };
    setOperation(stopping);
    try {
      await api(
        `/agents/sessions/${id}/interrupt`,
        acceptedSchema,
        json("POST"),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperation((current) => (current === stopping ? null : current));
    }
  }

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
    if ((!draft.trim() && !attachments.length) || controlsLocked) return;
    const text = draft;
    const submittedAttachments = attachments;
    const context = getContext();
    const submission: TurnSubmission = {
      kind: "turn",
      stopped: false,
      sessionId: session?.id,
    };
    setOperation(submission);
    setError("");
    try {
      await waitForNoteCaptures(projectId);
      if (submission.stopped) return;
      const files = [
        ...new Set([
          ...submittedAttachments,
          ...(await getReviewAttachments()),
        ]),
      ].slice(0, 30);
      if (submission.stopped) return;
      let active = session;
      if (!active || active.provider !== provider) {
        active = await api(
          "/agents/sessions",
          agentSessionSchema,
          json("POST", { projectId, provider, ...(model ? { model } : {}) }),
        );
        if (submission.stopped) return;
        submission.sessionId = active.id;
        setConversation({ phase: "ready", session: active });
      }
      if (active.model !== (model || undefined)) {
        active = await api(
          `/agents/sessions/${active.id}`,
          agentSessionSchema,
          json("PATCH", { model: model || null }),
        );
        if (submission.stopped) return;
        setConversation({ phase: "ready", session: active });
        setModel(active.model ?? "");
      }
      const mentioned = new Set(
        [...text.matchAll(/\$([\w:/.-]+)/g)].map((match) => match[1]),
      );
      const skills =
        capabilities?.skills
          .filter((skill) => skill.enabled && mentioned.has(skill.name))
          .map(({ name, path }) => ({ name, path })) ?? [];
      await api(
        `/agents/sessions/${active.id}/turns`,
        acceptedSchema,
        json("POST", {
          text,
          skills,
          attachments: files.map((path) => ({ path })),
          context,
        }),
      );
      if (submission.stopped) return;
      setDraft((current) => (current === text ? "" : current));
      setAttachments((current) =>
        current.filter((path) => !submittedAttachments.includes(path)),
      );
      follow.current = true;
      onSent();
      void loadSessions().catch(() => {});
    } catch (error) {
      if (!submission.stopped)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperation((current) => (current === submission ? null : current));
    }
  }

  return (
    <aside className="chat-panel" aria-label="Agent chat" hidden={!visible}>
      {active ? (
        <div className="chat-toolbar presence" data-state={session?.status}>
          <span>
            <strong>
              {operation?.kind === "stop"
                ? "Stopping"
                : session?.status === "waiting"
                  ? "Needs you"
                  : busy
                    ? "Working"
                    : "Sending"}
            </strong>
            {busy &&
              session?.status === "running" &&
              workingNote &&
              ` on note ${workingNote}`}
          </span>
          {busy && turnStart && <Elapsed since={turnStart} />}
          <button
            className="icon-button"
            aria-label="Stop agent"
            title="Stop agent"
            disabled={operation?.kind === "stop"}
            onClick={() => void stop()}
          >
            <Square weight="fill" />
          </button>
        </div>
      ) : (
        <div className="chat-toolbar">
          {sessions.length === 0 && (
            <span className="chat-toolbar-title">New conversation</span>
          )}
          {sessions.length > 0 && (
            <SelectMenu
              className="select-label conversation-picker"
              title={sessions.find((item) => item.id === sessionId)?.title}
              label="Conversation"
              value={sessionId ?? ""}
              disabled={controlsLocked}
              options={[
                { value: "", label: "New conversation" },
                ...sessions.map((item) => ({
                  value: item.id,
                  label: item.title,
                })),
              ]}
              onChange={(selected) => {
                setConversation(
                  selected
                    ? { phase: "loading", id: selected }
                    : { phase: "new" },
                );
                const next = sessions.find((item) => item.id === selected);
                if (next) {
                  setProvider(next.provider);
                  setModel(next.model ?? "");
                }
              }}
            />
          )}
          <span className="quiet-label">
            {opening
              ? "Opening"
              : operation?.kind === "model"
                ? "Saving model"
                : ""}
          </span>
          <button
            className="icon-button"
            aria-label="Refresh agent configuration"
            disabled={controlsLocked || discovering}
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
            disabled={controlsLocked}
            onClick={() => {
              setConversation({ phase: "new" });
              setError("");
              textarea.current?.focus();
            }}
          >
            <Plus />
          </button>
        </div>
      )}
      {alwaysAllow && (
        <div className="agent-permissions">
          <span>Cutroom edits always allowed</span>
          <button
            className="text-button quiet"
            onClick={() => {
              void api(
                `/projects/${projectId}/agent-permissions`,
                agentPermissionsSchema,
                json("PATCH", { alwaysAllowCutroomEdits: false }),
              )
                .then(() => setAlwaysAllow(false))
                .catch((error) => setError(String(error)));
            }}
          >
            Revoke
          </button>
        </div>
      )}
      <ConversationMessages
        session={session}
        capabilities={capabilities}
        discovering={discovering}
        messagesRef={messages}
        followRef={follow}
        onRespond={respondToRequest}
      />
      {session?.pendingRequest?.kind === "approval" && (
        <RequestCard
          key={session.pendingRequest.id}
          request={session.pendingRequest}
          onRespond={respondToRequest}
        />
      )}
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
            placeholder="Describe the next edit"
            title="Enter to send, Shift+Enter for a new line"
            value={draft}
            rows={1}
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
                title="Attach a file"
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
              <SelectMenu
                className="select-label"
                label="Agent provider"
                title={`${provider === "codex" ? "Codex" : "Claude Code"} ${capabilities?.version ?? ""}`.trim()}
                value={provider}
                disabled={controlsLocked}
                options={[
                  { value: "codex", label: "Codex" },
                  { value: "claude", label: "Claude Code" },
                ]}
                onChange={(selected) => {
                  setProvider(selected);
                  setModel("");
                  setConversation({ phase: "new" });
                  setError("");
                }}
              />
              <SelectMenu
                className="select-label model-select"
                label="Model"
                value={model}
                disabled={controlsLocked || discovering}
                options={[
                  { value: "", label: "Default model" },
                  ...(capabilities?.models.map((item) => ({
                    value: item.id,
                    label: item.name,
                  })) ?? []),
                ]}
                onChange={(selected) => {
                  if (!session) {
                    setModel(selected);
                    return;
                  }
                  const changing: ChatOperation = { kind: "model" };
                  setOperation(changing);
                  void api(
                    `/agents/sessions/${session.id}`,
                    agentSessionSchema,
                    json("PATCH", { model: selected || null }),
                  )
                    .then((result) => {
                      setConversation((current) =>
                        current.phase === "ready" &&
                        current.session.id === result.id
                          ? { phase: "ready", session: result }
                          : current,
                      );
                      setModel(result.model ?? "");
                    })
                    .catch((error: unknown) =>
                      setError(
                        error instanceof Error ? error.message : String(error),
                      ),
                    )
                    .finally(() =>
                      setOperation((current) =>
                        current === changing ? null : current,
                      ),
                    );
                }}
              />
            </div>
            <button
              className="send-button"
              aria-label="Send message"
              disabled={
                controlsLocked ||
                discovering ||
                !capabilities?.available ||
                (!draft.trim() && !attachments.length)
              }
              onClick={() => void send()}
            >
              <ArrowUp weight="bold" />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
