import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowUp, Paperclip, X } from "@phosphor-icons/react";
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
  type AgentSessionSummary,
  type ConfigureAgentSession,
  type AgentSkill,
} from "../../shared/agent";
import type { Project } from "../../shared/project";
import type { ReviewItem } from "../../shared/review";
import { ApiError, api, json } from "../api";
import { useWorkspace } from "../workspace";
import { ModelMenu, providerNames, selectedModel } from "./chat/ModelMenu";
import { ChatList, RecentChats, chatIsBusy } from "./chat/ChatList";
import { openNativeChat } from "./chat/SharedChats";
import { Attachments } from "./chat/Attachments";
import { RequestCard } from "./chat/RequestCard";
import { Transcript } from "./chat/Transcript";
import { chatClock } from "./chat/clock";
import { waitForNoteCaptures } from "../edit/noteStore";

const sessionListSchema = z.object({
  sessions: z.array(agentSessionSummarySchema),
});
const acceptedSchema = agentSessionSchema;
const sentSchema = acceptedSchema.extend({ queued: z.boolean().optional() });
const deletedSchema = z.object({ deleted: z.literal(true) });

function lastChatKey(projectId: string) {
  return `cutroom:chat:${projectId}`;
}

function lastChat(projectId: string, chats: AgentSessionSummary[]) {
  try {
    const id = localStorage.getItem(lastChatKey(projectId));
    return chats.find((chat) => chat.id === id) ?? chats[0];
  } catch {
    return chats[0];
  }
}
const modelChoiceSchema = agentSessionSchema.pick({
  model: true,
  effort: true,
});
type ModelChoice = z.infer<typeof modelChoiceSchema>;

function modelChoiceKey(projectId: string, provider: AgentProvider) {
  return `cutroom:model:${projectId}:${provider}`;
}

function readModelChoice(
  projectId: string,
  provider: AgentProvider,
): ModelChoice {
  try {
    return (
      modelChoiceSchema.safeParse(
        JSON.parse(
          localStorage.getItem(modelChoiceKey(projectId, provider)) ?? "null",
        ),
      ).data ?? {}
    );
  } catch {
    return {};
  }
}

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

type ChatState =
  | { phase: "restoring" }
  | { phase: "new" }
  | { phase: "loading"; selected: AgentSessionSummary }
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
  | { kind: "branch" }
  | { kind: "resume-follow-ups" }
  | { kind: "remove-follow-up" };

function applyChatEvents(
  state: ChatState,
  id: string,
  events: AgentEvent[],
): ChatState {
  if (state.phase === "new" || state.phase === "restoring") return state;
  if ((state.phase === "ready" ? state.session.id : state.selected.id) !== id)
    return state;
  let session = state.phase === "ready" ? state.session : null;
  for (const event of events) {
    if (event.type === "snapshot") {
      if (event.session.id !== id) continue;
      const next = event.session;
      // Settings updates also send full snapshots. Keep unchanged transcript inputs stable.
      session = {
        ...next,
        messages:
          session &&
          JSON.stringify(session.messages) === JSON.stringify(next.messages)
            ? session.messages
            : next.messages,
        pendingRequest:
          session &&
          JSON.stringify(session.pendingRequest) ===
            JSON.stringify(next.pendingRequest)
            ? session.pendingRequest
            : next.pendingRequest,
      };
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
    if (event.type === "native-session")
      session = { ...session, nativeSessionId: event.nativeSessionId };
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

function webThreadLink(link: string | undefined) {
  if (!link) return undefined;
  const url = URL.parse(link);
  if (url && (url.protocol === "https:" || url.protocol === "http:"))
    return url.href;
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
  project,
  visible,
  getContext,
  getReviewAttachments,
  onSent,
  prompt,
  onPromptConsumed,
  pickAttachment,
  workingNote,
  waitingNotes,
  onOpenNote,
}: {
  project: Pick<Project, "id" | "path">;
  visible: boolean;
  getContext: () => string;
  getReviewAttachments: () => Promise<string[]>;
  onSent: () => void;
  prompt: string | null;
  onPromptConsumed: () => void;
  pickAttachment: () => Promise<string | null>;
  /** The number, as in Review, of the note the agent has claimed. */
  workingNote: number | null;
  waitingNotes: readonly ReviewItem[];
  onOpenNote: (note: ReviewItem) => void;
}) {
  const projectId = project.id;
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
  const [preferences, setPreferences] = useState(() => ({
    codex: readModelChoice(projectId, "codex"),
    claude: readModelChoice(projectId, "claude"),
  }));
  const [catalog, setCatalog] = useState<
    Partial<Record<AgentProvider, AgentCapabilities>>
  >({});
  const capabilities = catalog[provider];
  const discovering = !capabilities;
  const [configurationRevision, setConfigurationRevision] = useState(0);
  const [sessions, setSessions] = useState<
    z.infer<typeof sessionListSchema>["sessions"]
  >([]);
  const listRequest = useRef(0);
  // An in-flight request can finish after the owner has opened a different chat.
  const view = useRef(0);
  const [chat, setChat] = useState<ChatState>({
    phase: "restoring",
  });
  const session = chat.phase === "ready" ? chat.session : null;
  const savedChoice = preferences[provider];
  const savedModel = selectedModel(capabilities, savedChoice.model);
  const model = session ? session.model : savedModel && savedChoice.model;
  const effort = session
    ? session.effort
    : savedChoice.effort && savedModel?.efforts.includes(savedChoice.effort)
      ? savedChoice.effort
      : undefined;
  const sessionId =
    chat.phase === "ready"
      ? chat.session.id
      : chat.phase === "loading"
        ? chat.selected.id
        : null;
  const linkedThread =
    chat.phase === "loading" ? chat.selected.t3Thread : session?.t3Thread;
  const opening = chat.phase === "restoring" || chat.phase === "loading";
  const [draft, setDraft] = useState(() => readDraft(projectId)?.text ?? "");
  const [attachments, setAttachments] = useState<string[]>(
    () => readDraft(projectId)?.attachments ?? [],
  );
  const draftFiles = useMemo(
    () => attachments.map((path) => ({ path })),
    [attachments],
  );
  const removeAttachment = useCallback((path: string) => {
    setAttachments((items) => items.filter((item) => item !== path));
  }, []);
  const [skillChoices, setSkillChoices] = useState(
    () => readDraft(projectId)?.skillChoices ?? {},
  );
  const [notice, setNotice] = useState<{
    message: string;
    kind: "error" | "conflict" | "queued";
  } | null>(null);
  const setError = useCallback((message: string) => {
    setNotice(message ? { message, kind: "error" } : null);
  }, []);
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
    const request = ++listRequest.current;
    const result = await api(
      `/agents/sessions?projectId=${encodeURIComponent(projectId)}`,
      sessionListSchema,
    );
    if (request === listRequest.current) setSessions(result.sessions);
    return result.sessions;
  }, [projectId]);

  const selectChat = useCallback(
    (selected: AgentSessionSummary) => {
      view.current++;
      setOperation(null);
      setError("");
      setProvider(selected.provider);
      follow.current = true;
      setChat({ phase: "loading", selected });
      try {
        localStorage.setItem(lastChatKey(projectId), selected.id);
      } catch {
        /* Selection works without browser storage. */
      }
    },
    [projectId, setError],
  );

  const newChat = useCallback(() => {
    view.current++;
    setOperation(null);
    setChat({ phase: "new" });
    setError("");
    textarea.current?.focus();
  }, [setError]);

  useEffect(() => {
    let cancelled = false;
    void loadSessions()
      .then((items) => {
        if (cancelled) return;
        const recent = lastChat(projectId, items);
        if (recent) selectChat(recent);
        else setChat({ phase: "new" });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setChat({ phase: "new" });
          setError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadSessions, projectId, selectChat]);

  const hasMessages = Boolean(session?.messages.length);
  useEffect(() => {
    if (!sessionId || !hasMessages) return;
    try {
      localStorage.setItem(lastChatKey(projectId), sessionId);
    } catch {
      /* Selection works without browser storage. */
    }
  }, [sessionId, hasMessages, projectId]);

  const discover = chat.phase !== "restoring" && !linkedThread;
  useEffect(() => {
    if (!discover) return;
    let cancelled = false;
    setCatalog({});
    for (const provider of agentProviderSchema.options) {
      void api(
        `/agents/capabilities?provider=${provider}&projectId=${encodeURIComponent(projectId)}${configurationRevision ? "&refresh=true" : ""}`,
        agentCapabilitiesSchema,
      )
        .catch((error: unknown): AgentCapabilities => ({
          provider,
          available: false,
          models: [],
          skills: [],
          mcpServers: [],
          error: error instanceof Error ? error.message : String(error),
        }))
        .then((result) => {
          if (!cancelled)
            setCatalog((current) => ({ ...current, [provider]: result }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [discover, projectId, configurationRevision]);

  useEffect(() => {
    useWorkspace.setState({
      agent: linkedThread
        ? { name: "T3 Code", available: true }
        : capabilities
          ? {
              name: providerNames[provider],
              available: capabilities.available,
            }
          : null,
    });
  }, [capabilities, linkedThread, provider]);
  useEffect(() => () => useWorkspace.setState({ agent: null }), []);

  useEffect(() => {
    if (!sessionId) return;
    const openedView = view.current;
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
      if (closed || view.current !== openedView || !pending.length) return;
      const events = pending;
      pending = [];
      setChat((current) => applyChatEvents(current, sessionId, events));
      for (const event of events)
        if (event.type === "error")
          setNotice({
            message: event.message,
            kind:
              event.code === "native_session_conflict" ? "conflict" : "error",
          });
      if (events.some((event) => event.type === "status"))
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
    !linkedThread && session?.pendingRequest?.kind === "question"
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
    if (prompt === null) return;
    if (prompt) setDraft((value) => (value ? `${value}\n\n${prompt}` : prompt));
    textarea.current?.focus();
    onPromptConsumed();
  }, [prompt, onPromptConsumed]);

  const skillQuery =
    linkedThread || skillDismissed
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
  const request = linkedThread ? undefined : session?.pendingRequest;
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
  const busy = session ? chatIsBusy(session) : false;
  const followUps = (session?.queuedTurns ?? []).filter(
    ({ id }) => id !== session?.runningFollowUpId,
  );
  const queuesMessage = !linkedThread && (busy || followUps.length > 0);
  const sendAvailable =
    !submitting &&
    !opening &&
    (Boolean(linkedThread) || (!discovering && capabilities?.available));
  const canSend = sendAvailable && Boolean(draft.trim() || attachments.length);
  const controlsLocked = busy || submitting || opening;
  const canStop =
    !linkedThread &&
    (busy || operation?.kind === "turn" || operation?.kind === "stop");
  const resuming = operation?.kind === "resume-follow-ups";
  const active = canStop || resuming || (linkedThread && (busy || submitting));
  const sendLabel = linkedThread
    ? "Send to T3 Code"
    : queuesMessage
      ? "Queue follow-up"
      : "Send message";
  // A turn starts with the owner's latest message.
  const turnStart = linkedThread
    ? undefined
    : session?.messages.findLast((message) => message.role === "user")
        ?.createdAt;

  async function stop() {
    const openedView = view.current;
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
      if (view.current === openedView)
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

  async function send(sendNotes = false) {
    if (!sendAvailable || (!sendNotes && !canSend)) return;
    const openedView = view.current;
    const text =
      sendNotes && !draft.trim() ? "Work through my review notes." : draft;
    const submittedAttachments = attachments;
    const skills = linkedThread
      ? []
      : [...skillMentions(text)].flatMap((name) => {
          const choice = skillChoices[name];
          if (choice?.provider === provider)
            return [{ name, path: choice.path }];
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
    let createdId: string | undefined;
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
      if (!active || (!linkedThread && active.provider !== provider)) {
        active = await api(
          "/agents/sessions",
          agentSessionSchema,
          json("POST", { projectId, provider, model, effort }),
        );
        createdId = active.id;
        submission.sessionId = active.id;
        if (submission.stopped) return;
        if (view.current === openedView)
          setChat({ phase: "ready", session: active });
      }
      const sent = await api(
        `/agents/sessions/${active.id}/${queuesMessage ? "follow-ups" : "turns"}`,
        sentSchema,
        json("POST", {
          text,
          skills,
          attachments: files.map((path) => ({ path })),
          context,
        }),
      );
      createdId = undefined;
      if (submission.stopped) return;
      if (sent.queued && linkedThread && view.current === openedView)
        setNotice({ message: "Queued in T3 Code", kind: "queued" });
      setDraft((current) => (current === draft ? "" : current));
      setAttachments((current) =>
        current.filter((path) => !submittedAttachments.includes(path)),
      );
      follow.current = true;
      onSent();
      void loadSessions().catch(() => {});
    } catch (error) {
      if (!submission.stopped && view.current === openedView)
        setNotice({
          message: error instanceof Error ? error.message : String(error),
          kind:
            error instanceof ApiError &&
            error.code === "native_session_conflict"
              ? "conflict"
              : "error",
        });
    } finally {
      if (createdId) {
        // A refused or cancelled first send can leave an empty server record.
        const id = createdId;
        const unused = await api(
          `/agents/sessions/${id}`,
          agentSessionSchema,
        ).catch(() => null);
        if (unused && !unused.messages.length && !chatIsBusy(unused)) {
          const deleted = await api(
            `/agents/sessions/${id}`,
            deletedSchema,
            json("DELETE"),
          ).catch(() => null);
          if (deleted && view.current === openedView)
            setChat((current) =>
              current.phase === "ready" && current.session.id === id
                ? { phase: "new" }
                : current,
            );
        }
        void loadSessions().catch(() => {});
      }
      setOperation((current) => (current === submission ? null : current));
    }
  }

  async function branchChat() {
    if (!session?.nativeSessionId || submitting) return;
    const openedView = view.current;
    const branching: ChatOperation = { kind: "branch" };
    setOperation(branching);
    try {
      const branched = await openNativeChat(
        projectId,
        "branch",
        session.provider,
        session.nativeSessionId,
      );
      void loadSessions().catch(() => {});
      if (view.current !== openedView) return;
      selectChat(branched);
      textarea.current?.focus();
    } catch (error) {
      if (view.current === openedView)
        setNotice({
          message: error instanceof Error ? error.message : String(error),
          kind: "conflict",
        });
    } finally {
      setOperation((current) => (current === branching ? null : current));
    }
  }

  function rememberChoice(provider: AgentProvider, choice: ModelChoice) {
    setPreferences((current) => ({ ...current, [provider]: choice }));
    try {
      localStorage.setItem(
        modelChoiceKey(projectId, provider),
        JSON.stringify(choice),
      );
    } catch {
      // The choice still applies in this window when storage is disabled.
    }
  }

  async function configureModel(
    change: Pick<ConfigureAgentSession, "model" | "effort">,
  ) {
    if (controlsLocked) return;
    setError("");
    if (!session) {
      const nextModel =
        change.model === undefined ? model : (change.model ?? undefined);
      const offered = selectedModel(capabilities, nextModel)?.efforts;
      const nextEffort =
        change.effort === undefined ? effort : (change.effort ?? undefined);
      rememberChoice(provider, {
        model: nextModel,
        effort:
          nextEffort && offered?.includes(nextEffort) ? nextEffort : undefined,
      });
      return;
    }

    const openedView = view.current;
    const changing: ChatOperation = { kind: "model" };
    setOperation(changing);
    try {
      const result = await api(
        `/agents/sessions/${session.id}`,
        agentSessionSchema,
        json("PATCH", change),
      );
      void loadSessions().catch(() => {});
      if (view.current !== openedView) return;
      setChat((current) => {
        if (
          current.phase !== "ready" ||
          current.session.updatedAt > result.updatedAt
        )
          return current;
        return {
          phase: "ready",
          session: {
            ...current.session,
            model: result.model,
            effort: result.effort,
            updatedAt: result.updatedAt,
          },
        };
      });
      rememberChoice(provider, {
        model: change.model === null ? undefined : result.model,
        effort: result.effort,
      });
    } catch (error) {
      if (view.current === openedView)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperation((current) => (current === changing ? null : current));
    }
  }

  function chooseModel(selected: AgentProvider, model: string | null) {
    if (controlsLocked) return;
    if (selected === provider) {
      void configureModel({ model });
      return;
    }
    const remembered = preferences[selected].effort;
    const offered = selectedModel(
      catalog[selected],
      model ?? undefined,
    )?.efforts;
    rememberChoice(selected, {
      model: model ?? undefined,
      effort:
        remembered && offered?.includes(remembered) ? remembered : undefined,
    });
    setProvider(selected);
    newChat();
  }

  async function changeFollowUps(queuedId?: string) {
    if (!session || submitting) return;
    const openedView = view.current;
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
      if (view.current === openedView)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperation((current) => (current === change ? null : current));
      void loadSessions().catch(() => {});
    }
  }

  const renameChat = useCallback(async (id: string, title: string) => {
    const renamed = await api(
      `/agents/sessions/${id}`,
      agentSessionSchema,
      json("PATCH", { title }),
    );
    listRequest.current++;
    setSessions((items) =>
      items
        .map((item) =>
          item.id === id
            ? { ...item, title: renamed.title, updatedAt: renamed.updatedAt }
            : item,
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    );
  }, []);

  const deleteChat = useCallback(
    async (id: string) => {
      const openedView = view.current;
      await api(`/agents/sessions/${id}`, deletedSchema, json("DELETE"));
      listRequest.current++;
      const remaining = sessions.filter((item) => item.id !== id);
      setSessions((items) => items.filter((item) => item.id !== id));
      try {
        if (localStorage.getItem(lastChatKey(projectId)) === id)
          localStorage.removeItem(lastChatKey(projectId));
      } catch {
        /* Selection works without browser storage. */
      }
      const latest = await loadSessions().catch(() => remaining);
      if (id !== sessionId || view.current !== openedView) return false;
      if (!latest[0]) return true;
      selectChat(latest[0]);
      return false;
    },
    [loadSessions, projectId, selectChat, sessionId, sessions],
  );

  const refreshAgents = useCallback(() => {
    setError("");
    setConfigurationRevision((value) => value + 1);
  }, [setError]);

  return (
    <aside className="chat-panel" aria-label="Agent chat" hidden={!visible}>
      <ChatList
        chats={sessions}
        projectId={projectId}
        threadLink={webThreadLink(linkedThread?.link)}
        selectedId={sessionId}
        title={
          (chat.phase === "loading" ? chat.selected.title : undefined) ??
          sessions.find((item) => item.id === sessionId)?.title ??
          session?.title ??
          "New chat"
        }
        visible={visible}
        restoring={chat.phase === "restoring"}
        refreshDisabled={Boolean(linkedThread) || controlsLocked || discovering}
        working={busy}
        loadChats={loadSessions}
        onSelect={selectChat}
        onNew={newChat}
        onRename={renameChat}
        onDelete={deleteChat}
        onRefresh={refreshAgents}
        onError={setError}
      />
      {!linkedThread && alwaysAllow && (
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
      {chat.phase === "new" && (
        <RecentChats chats={sessions} onSelect={selectChat} />
      )}
      <Transcript
        project={project}
        messages={session?.messages}
        provider={session?.provider ?? provider}
        busy={busy}
        problem={
          !linkedThread && capabilities && !capabilities.available
            ? (capabilities.error ?? "Choose an installed agent to begin.")
            : undefined
        }
        importedCount={
          session?.nativeImport?.omittedMessages
            ? Math.min(session.messages.length, 200)
            : undefined
        }
        messagesRef={messages}
        followRef={follow}
      >
        {question}
      </Transcript>
      {notice && (
        <div
          className="chat-error"
          data-notice={notice.kind === "queued" || undefined}
          role={notice.kind === "queued" ? "status" : "alert"}
        >
          <span>{notice.message}</span>
          <div className="chat-notice-actions">
            {notice.kind === "conflict" && session?.nativeSessionId && (
              <button
                className="text-button"
                disabled={submitting}
                onClick={() => void branchChat()}
              >
                Branch
              </button>
            )}
            <button
              className="icon-button"
              aria-label={
                notice.kind === "queued"
                  ? "Dismiss agent notice"
                  : "Dismiss agent error"
              }
              onClick={() => setError("")}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}
      {active && (
        <div className="presence" data-state={session?.status}>
          <span role="status">
            <strong>
              {linkedThread && busy
                ? session?.status === "waiting"
                  ? "Answer in T3 Code"
                  : "Working in T3 Code"
                : operation?.kind === "stop"
                  ? "Stopping"
                  : session?.status === "waiting"
                    ? "Needs you"
                    : busy
                      ? "Working"
                      : resuming
                        ? "Resuming"
                        : "Sending"}
            </strong>
            {!linkedThread &&
              busy &&
              session?.status === "running" &&
              workingNote &&
              ` on note ${workingNote}`}
          </span>
          {busy && turnStart && <Elapsed since={turnStart} />}
        </div>
      )}
      {!linkedThread && session?.pendingRequest?.kind === "approval" && (
        <RequestCard
          key={session.pendingRequest.id}
          request={session.pendingRequest}
          onRespond={respondToRequest}
        />
      )}
      {!linkedThread && followUps.length > 0 && (
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
          {waitingNotes.length > 0 && (
            <div
              className="chat-review-notes"
              title="Sent with your next message"
            >
              <span className="chat-review-mark" aria-hidden="true" />
              <span>
                {waitingNotes.length}{" "}
                {waitingNotes.length === 1 ? "note" : "notes"}
              </span>
              <div className="chat-review-frames">
                {waitingNotes.slice(0, 3).map((note) => (
                  <button
                    key={note.id}
                    type="button"
                    className="chat-review-thumb"
                    aria-label={`Open review note ${note.body}`}
                    onClick={() => onOpenNote(note)}
                  >
                    {note.framePath && (
                      <img
                        src={`/api/cutroom/projects/${projectId}/attachments/${encodeURIComponent(note.framePath.split("/").at(-1) ?? "")}`}
                        alt=""
                        decoding="async"
                      />
                    )}
                  </button>
                ))}
              </div>
              {waitingNotes.length > 3 && (
                <span className="chat-review-more mono">
                  +{waitingNotes.length - 3}
                </span>
              )}
              <button
                type="button"
                className="text-button quiet"
                disabled={!sendAvailable}
                onClick={() => void send(true)}
              >
                Send now
              </button>
            </div>
          )}
          {attachments.length > 0 && (
            <Attachments
              project={project}
              files={draftFiles}
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
              {linkedThread ? (
                <span
                  className="chat-t3-label"
                  title="T3 Code runs this chat with its own model and approvals"
                >
                  T3 Code
                </span>
              ) : (
                <ModelMenu
                  catalog={catalog}
                  provider={provider}
                  model={model}
                  effort={effort}
                  hasMessages={hasMessages}
                  disabled={
                    !visible ||
                    discovering ||
                    busy ||
                    opening ||
                    (submitting && operation?.kind !== "model")
                  }
                  locked={busy}
                  pending={operation?.kind === "model"}
                  onModel={chooseModel}
                  onEffort={(nextEffort) =>
                    void configureModel({ effort: nextEffort })
                  }
                />
              )}
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
              aria-label={sendLabel}
              title={sendLabel}
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
