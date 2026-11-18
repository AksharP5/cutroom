import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowClockwise,
  ArrowUp,
  CaretDown,
  Paperclip,
  Plus,
  X,
} from "@phosphor-icons/react";
import { z } from "zod";
import {
  agentPermissionsSchema,
  agentProviderSchema,
  agentCapabilitiesSchema,
  agentEventEnvelopeSchema,
  agentSessionSchema,
  agentSessionSummarySchema,
  type AgentCapabilities,
  type AgentEvent,
  type AgentProvider,
  type AgentSession,
  type AgentSkill,
} from "../../shared/agent";
import { api, json } from "../api";
import { useWorkspace } from "../workspace";
import { SelectMenu } from "./SelectMenu";
import { Attachments } from "./chat/Attachments";
import { RequestCard } from "./chat/RequestCard";
import { Transcript } from "./chat/Transcript";
import { chatClock } from "./chat/clock";
import { waitForNoteCaptures } from "../edit/noteStore";

const sessionListSchema = z.object({
  sessions: z.array(agentSessionSummarySchema),
});
const acceptedSchema = agentSessionSchema;
const draftSchema = z.object({
  version: z.literal(1),
  text: z.string(),
  attachments: z.array(z.string()),
  skillChoices: z
    .record(
      z.string(),
      z.object({ provider: agentProviderSchema, path: z.string() }),
    )
    .default({}),
});

const skillMentions = (text: string) =>
  new Set(text.match(/\$[\w:/.-]+/g)?.map((mention) => mention.slice(1)));

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
type TurnSubmission = {
  kind: "turn" | "follow-up";
  stopped: boolean;
  sessionId?: string;
};
type ChatOperation =
  | TurnSubmission
  | { kind: "model" }
  | { kind: "stop" }
  | { kind: "resume-follow-ups" }
  | { kind: "remove-follow-up" };

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
    if (event.type === "turn-queue")
      session = {
        ...session,
        queuedTurns: event.turns,
        runningFollowUpId: event.runningId,
      };
    if (event.type === "request")
      session = { ...session, pendingRequest: event.request };
    if (event.type === "request-resolved")
      session = { ...session, pendingRequest: undefined };
  }
  return session ? { phase: "ready", session } : state;
}

/** Elapsed agent time as a clock (m:ss), not timecode. Re-renders only itself. */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  if (!Number.isFinite(seconds)) return null;
  return <span className="presence-clock mono">{chatClock(seconds)}</span>;
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
  const removeAttachment = useCallback((path: string) => {
    setAttachments((items) => items.filter((item) => item !== path));
  }, []);
  const [skillChoices, setSkillChoices] = useState(
    () => readDraft(projectId)?.skillChoices ?? {},
  );
  const [error, setError] = useState("");
  const [operation, setOperation] = useState<ChatOperation | null>(null);
  const submitting = operation !== null;
  const [skillIndex, setSkillIndex] = useState(0);
  const [skillDismissed, setSkillDismissed] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const skillCaret = useRef<number | null>(null);
  const messages = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const pendingDraft = useRef({
    version: 1 as const,
    text: draft,
    attachments,
    skillChoices,
  });
  pendingDraft.current = { version: 1, text: draft, attachments, skillChoices };

  useEffect(() => {
    setSkillChoices((previous) => {
      const named = Object.entries(previous);
      if (!named.length) return previous;
      const mentions = skillMentions(draft);
      const remaining = named.filter(([name]) => mentions.has(name));
      return remaining.length === named.length
        ? previous
        : Object.fromEntries(remaining);
    });
  }, [draft]);

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
  }, [draft, attachments, skillChoices, saveDraft]);

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
  }, [session?.messages, session?.pendingRequest, session?.status]);

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
  const request = session?.pendingRequest;
  const question = useMemo(
    () =>
      request?.kind === "question" && (
        <RequestCard
          key={request.id}
          request={request}
          onRespond={respondToRequest}
        />
      ),
    [request, respondToRequest],
  );
  const busy = session?.status === "running" || session?.status === "waiting";
  const followUps = (session?.queuedTurns ?? []).filter(
    ({ id }) => id !== session?.runningFollowUpId,
  );
  const queuesMessage = busy || followUps.length > 0;
  const canSend =
    !submitting &&
    !opening &&
    !discovering &&
    capabilities?.available &&
    (draft.trim() || attachments.length);
  const controlsLocked = busy || submitting || opening;
  const canStop =
    busy || operation?.kind === "turn" || operation?.kind === "stop";
  const resuming = operation?.kind === "resume-follow-ups";
  const active = canStop || resuming;
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

  useLayoutEffect(() => {
    const caret = skillCaret.current;
    if (caret === null) return;
    skillCaret.current = null;
    textarea.current?.focus();
    textarea.current?.setSelectionRange(caret, caret);
  }, [draft]);

  function insertSkill(skill: AgentSkill) {
    const path = skill.path;
    if (path)
      setSkillChoices((previous) => ({
        ...previous,
        [skill.name]: { provider, path },
      }));
    const input = textarea.current;
    const caret = input?.selectionStart ?? draft.length;
    const before = draft
      .slice(0, caret)
      .replace(/\$[\w:/.-]*$/, `$${skill.name} `);
    skillCaret.current = before.length;
    setDraft(before + draft.slice(caret));
    setSkillDismissed(true);
  }

  async function send() {
    if (!canSend) return;
    const text = draft;
    const submittedAttachments = attachments;
    const skills = [...skillMentions(text)].flatMap((name) => {
      const choice = skillChoices[name];
      if (choice?.provider === provider) return [{ name, path: choice.path }];
      const skill = capabilities?.skills.find(
        (candidate) => candidate.enabled && candidate.name === name,
      );
      return skill ? [{ name, path: skill.path }] : [];
    });
    const context = getContext();
    const submission: TurnSubmission = {
      kind: queuesMessage ? "follow-up" : "turn",
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
      if (!queuesMessage && active.model !== (model || undefined)) {
        active = await api(
          `/agents/sessions/${active.id}`,
          agentSessionSchema,
          json("PATCH", { model: model || null }),
        );
        if (submission.stopped) return;
        setConversation({ phase: "ready", session: active });
        setModel(active.model ?? "");
      }
      await api(
        `/agents/sessions/${active.id}/${queuesMessage ? "follow-ups" : "turns"}`,
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

  async function changeFollowUps(queuedId?: string) {
    if (!session || submitting) return;
    const change: ChatOperation = queuedId
      ? { kind: "remove-follow-up" }
      : { kind: "resume-follow-ups" };
    setOperation(change);
    setError("");
    try {
      await api(
        `/agents/sessions/${session.id}/follow-ups/${queuedId ?? "resume"}`,
        acceptedSchema,
        json(queuedId ? "DELETE" : "POST"),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperation((current) => (current === change ? null : current));
    }
  }

  return (
    <aside className="chat-panel" aria-label="Agent chat" hidden={!visible}>
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
      <Transcript
        messages={session?.messages}
        provider={session?.provider ?? provider}
        busy={busy}
        problem={
          capabilities && !capabilities.available
            ? (capabilities.error ?? "Choose an installed agent to begin.")
            : undefined
        }
        messagesRef={messages}
        followRef={follow}
      >
        {question}
      </Transcript>
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
      {active && (
        <div className="presence" data-state={session?.status}>
          <span role="status">
            <strong>
              {operation?.kind === "stop"
                ? "Stopping"
                : session?.status === "waiting"
                  ? "Needs you"
                  : busy
                    ? "Working"
                    : resuming
                      ? "Resuming"
                      : "Sending"}
            </strong>
            {busy &&
              session?.status === "running" &&
              workingNote &&
              ` on note ${workingNote}`}
          </span>
          {busy && turnStart && <Elapsed since={turnStart} />}
        </div>
      )}
      {session?.pendingRequest?.kind === "approval" && (
        <RequestCard
          key={session.pendingRequest.id}
          request={session.pendingRequest}
          onRespond={respondToRequest}
        />
      )}
      {followUps.length > 0 && (
        <section className="chat-follow-ups" aria-label="Queued follow-ups">
          {!active && (
            <button
              className="text-button"
              disabled={submitting}
              onClick={() => void changeFollowUps()}
            >
              Resume queue
            </button>
          )}
          <ol role="list">
            {followUps.map(({ id, turn }) => (
              <li key={id}>
                <span title={turn.text}>
                  {turn.text.trim() || "Attached media"}
                </span>
                <button
                  className="icon-button"
                  aria-label="Remove queued follow-up"
                  title="Remove follow-up"
                  disabled={submitting}
                  onClick={() => void changeFollowUps(id)}
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ol>
        </section>
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
                {skill.path &&
                  skillResults.some(
                    (other) =>
                      other.name === skill.name && other.path !== skill.path,
                  ) && (
                    <small className="skill-origin" title={skill.path}>
                      {skill.path}
                    </small>
                  )}
              </button>
            ))}
          </div>
        )}
        <div className="composer">
          {attachments.length > 0 && (
            <Attachments
              projectId={projectId}
              paths={attachments}
              onRemove={removeAttachment}
            />
          )}
          <textarea
            ref={textarea}
            aria-label="Message your agent"
            placeholder="Ask for an edit, or draw on the picture"
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
            {canStop && (
              <button
                className="chat-stop"
                aria-label="Stop agent"
                title="Stop agent"
                disabled={operation?.kind === "stop"}
                onClick={() => void stop()}
              >
                <span aria-hidden="true" />
              </button>
            )}
            <button
              className="send-button"
              aria-label={queuesMessage ? "Queue follow-up" : "Send message"}
              title={queuesMessage ? "Queue follow-up" : "Send message"}
              disabled={!canSend}
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
