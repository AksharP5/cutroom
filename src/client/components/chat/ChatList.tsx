import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  CaretDown,
  CaretLeft,
  LinkSimple,
  Terminal,
  PencilSimple,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import { agentChatTitleLimit } from "../../../shared/agent";
import type { AgentSessionSummary } from "../../../shared/agent";
import { restoreMenuFocus } from "../../keymap";
import { menuStep } from "../menu";
import "../select-menu.css";

import { chatAge } from "./clock";
import { SharedChats } from "./SharedChats";
import type { SharedChatView } from "./SharedChats";

export function chatIsBusy(chat: AgentSessionSummary) {
  return chat.status === "running" || chat.status === "waiting";
}

function ChatLabel({ chat, now }: { chat: AgentSessionSummary; now: number }) {
  return (
    <>
      <span
        className="chat-list-mark"
        data-status={chat.status}
        role={chatIsBusy(chat) ? "img" : undefined}
        aria-label={
          chat.status === "running"
            ? "Working"
            : chat.status === "waiting"
              ? "Needs you"
              : undefined
        }
      />
      <span className="chat-list-name" title={chat.title}>
        {chat.title}
      </span>
      <span className="chat-list-meta">
        <span>
          {chat.t3Thread
            ? "T3 Code"
            : chat.provider === "codex"
              ? "Codex"
              : "Claude"}
        </span>
        <time className="mono" dateTime={chat.updatedAt}>
          {chatAge(chat.updatedAt, now)}
        </time>
      </span>
    </>
  );
}

export function RecentChats({
  chats,
  onSelect,
}: {
  chats: AgentSessionSummary[];
  onSelect: (chat: AgentSessionSummary) => void;
}) {
  const label = useId();
  const now = Date.now();
  if (!chats.length) return null;
  return (
    <section className="chat-recent" aria-labelledby={label}>
      <div id={label}>Recent</div>
      {chats.slice(0, 5).map((chat) => (
        <button
          key={chat.id}
          type="button"
          className="chat-list-pick"
          onClick={() => onSelect(chat)}
        >
          <ChatLabel chat={chat} now={now} />
        </button>
      ))}
    </section>
  );
}

type ChatEdit =
  | { kind: "rename"; id: string; title: string }
  | { kind: "delete"; id: string };

export const ChatList = memo(function ChatList({
  chats,
  projectId,
  threadLink,
  selectedId,
  title,
  visible,
  restoring,
  refreshDisabled,
  working,
  loadChats,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onRefresh,
  onError,
}: {
  chats: AgentSessionSummary[];
  projectId: string;
  threadLink?: string;
  selectedId: string | null;
  title: string;
  visible: boolean;
  restoring: boolean;
  refreshDisabled: boolean;
  working: boolean;
  loadChats: () => Promise<AgentSessionSummary[]>;
  onSelect: (chat: AgentSessionSummary) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<boolean>;
  onRefresh: () => void;
  onError: (message: string) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const search = useRef({ text: "", at: 0 });
  const focusRow = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<SharedChatView | null>(null);
  const [edit, setEdit] = useState<ChatEdit | null>(null);
  const [saving, setSaving] = useState(false);
  const shouldPoll = working || chats.some(chatIsBusy);
  const now = Date.now();

  useEffect(() => {
    if (!open || !shouldPoll || !visible) return;
    let stopped = false;
    let timer = setTimeout(poll, 2000);
    async function poll() {
      if (!popover.current?.matches(":popover-open")) return;
      const latest = await loadChats().catch(() => undefined);
      if (!stopped && (!latest || latest.some(chatIsBusy)))
        timer = setTimeout(poll, 2000);
    }
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [open, shouldPoll, visible, loadChats]);

  useEffect(() => {
    if (!visible) popover.current?.hidePopover();
  }, [visible]);

  function rows() {
    return Array.from(
      popover.current?.querySelectorAll<HTMLButtonElement>(
        "[data-menu-row]:not(:disabled)",
      ) ?? [],
    );
  }

  const editKind = edit?.kind;
  const editId = edit?.id;
  useLayoutEffect(() => {
    if (!open) return;
    if (editKind === "rename") {
      input.current?.focus();
      input.current?.select();
    } else if (editKind === "delete") {
      confirm.current?.focus();
    } else if (focusRow.current !== null) {
      const items = rows();
      const item =
        (focusRow.current &&
          items.find((row) => row.dataset.menuRow === focusRow.current)) ||
        items[0];
      item?.focus();
      focusRow.current = null;
    }
  }, [editId, editKind, open, mode]);

  function showView(next: SharedChatView | null) {
    focusRow.current = next ? "back" : mode;
    search.current = { text: "", at: 0 };
    if (popover.current) popover.current.scrollTop = 0;
    setMode(next);
  }

  function close(restore: boolean) {
    popover.current?.hidePopover();
    setOpen(false);
    setMode(null);
    setEdit(null);
    focusRow.current = null;
    if (restore) restoreMenuFocus(trigger.current);
  }

  function show(keyboard: boolean) {
    if (restoring) return;
    if (keyboard) focusRow.current = selectedId ?? "";
    search.current = { text: "", at: 0 };
    setOpen(true);
    popover.current?.showPopover({ source: trigger.current ?? undefined });
    void loadChats().catch((error: unknown) =>
      onError(error instanceof Error ? error.message : String(error)),
    );
  }

  function endEdit(rowId: string) {
    focusRow.current = rowId;
    setEdit(null);
  }

  async function submitEdit(change: ChatEdit) {
    if (saving) return;
    if (change.kind === "rename" && !change.title.trim()) return;
    setSaving(true);
    try {
      if (change.kind === "rename")
        await onRename(change.id, change.title.trim());
      else if (await onDelete(change.id)) {
        newChat();
        return;
      }
      if (popover.current?.matches(":popover-open")) endEdit(change.id);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      if (edit && !saving) endEdit(edit.id);
      else if (mode) showView(null);
      else close(true);
      return;
    }
    if (edit || event.target instanceof HTMLInputElement) return;
    const items = rows();
    const row = (
      event.target instanceof HTMLElement
        ? event.target.closest(".chat-list-row")
        : null
    )?.querySelector<HTMLButtonElement>("[data-menu-row]");
    if (
      mode === "native" &&
      event.target === row &&
      event.key.toLowerCase() === "b" &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      row?.parentElement
        ?.querySelector<HTMLButtonElement>(".chat-list-branch")
        ?.click();
      return;
    }
    const chat = mode
      ? undefined
      : chats.find((item) => item.id === row?.dataset.menuRow);
    if (chat && (event.key === "F2" || event.key === "Delete")) {
      event.preventDefault();
      if (event.key === "F2")
        setEdit({ kind: "rename", id: chat.id, title: chat.title });
      else if (!chatIsBusy(chat)) setEdit({ kind: "delete", id: chat.id });
      return;
    }
    const index = items.findIndex((item) => item === (row ?? event.target));
    const next = menuStep(
      event,
      items.map((item) => item.dataset.menuLabel ?? ""),
      index,
      search.current,
    );
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus({ preventScroll: true });
    items[next]?.scrollIntoView({ block: "nearest" });
  }

  function newChat() {
    close(false);
    onNew();
  }

  return (
    <div className="chat-toolbar">
      <button
        ref={trigger}
        type="button"
        className="select-trigger select-label chat-title"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        aria-label={`Chats, ${title}`}
        title={title}
        disabled={restoring}
        popoverTarget={id}
        onClick={(event) => {
          event.preventDefault();
          if (open) close(true);
          else show(event.detail === 0);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          event.stopPropagation();
          if (open)
            (
              rows().find((row) => row.dataset.menuRow === selectedId) ??
              rows()[0]
            )?.focus();
          else show(true);
        }}
      >
        <span>{title}</span>
        <CaretDown />
      </button>
      {threadLink && (
        <a
          className="icon-button chat-thread-link"
          href={threadLink}
          target="_blank"
          rel="noreferrer"
          aria-label="Open in T3 Code"
          title="Open in T3 Code"
        >
          <ArrowSquareOut />
        </a>
      )}
      <button
        type="button"
        className="icon-button"
        aria-label="New chat"
        title="New chat"
        disabled={restoring}
        onClick={newChat}
      >
        <Plus />
      </button>
      <div
        ref={popover}
        id={id}
        className="select-menu chat-list"
        popover="auto"
        role="menu"
        aria-label="Chats"
        data-shared={mode ?? undefined}
        onToggle={(event) => {
          if (event.newState === "closed") {
            setOpen(false);
            setMode(null);
            setEdit(null);
            focusRow.current = null;
          }
        }}
        onKeyDown={navigate}
      >
        {open && mode && (
          <>
            <button
              type="button"
              role="menuitem"
              data-menu-row="back"
              data-menu-label="Chats"
              onClick={() => showView(null)}
            >
              <CaretLeft /> Chats
            </button>
            <SharedChats
              key={mode}
              mode={mode}
              projectId={projectId}
              chats={chats}
              loadChats={loadChats}
              onSelect={(chat) => {
                if (chat.id !== selectedId) onSelect(chat);
                close(true);
              }}
            />
          </>
        )}
        {open && !mode && (
          <>
            {chats.map((chat) => {
              const working = chatIsBusy(chat);
              const deleting = edit?.id === chat.id && edit.kind === "delete";
              const renaming = edit?.id === chat.id && edit.kind === "rename";
              return (
                <div
                  className="chat-list-row"
                  data-current={selectedId === chat.id || undefined}
                  role="group"
                  aria-label={chat.title}
                  key={chat.id}
                >
                  {renaming ? (
                    <input
                      ref={input}
                      aria-label="Chat title"
                      maxLength={agentChatTitleLimit}
                      value={edit.title}
                      readOnly={saving}
                      onChange={(event) =>
                        setEdit({ ...edit, title: event.target.value })
                      }
                      onKeyDown={(event) => {
                        if (
                          event.key !== "Enter" ||
                          event.nativeEvent.isComposing
                        )
                          return;
                        event.preventDefault();
                        event.stopPropagation();
                        void submitEdit(edit);
                      }}
                    />
                  ) : deleting ? (
                    <>
                      <span>Delete this chat?</span>
                      <button
                        ref={confirm}
                        type="button"
                        className="chat-list-delete"
                        disabled={working || saving}
                        title={working ? "Stop the run first" : undefined}
                        onClick={() => void submitEdit(edit)}
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => endEdit(chat.id)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="chat-list-pick"
                        type="button"
                        role="menuitemradio"
                        aria-checked={selectedId === chat.id}
                        aria-label={chat.title}
                        aria-description={
                          chat.status === "running"
                            ? "Working"
                            : chat.status === "waiting"
                              ? "Needs you"
                              : undefined
                        }
                        data-menu-row={chat.id}
                        data-menu-label={chat.title}
                        tabIndex={-1}
                        onClick={() => {
                          if (chat.id !== selectedId) onSelect(chat);
                          close(true);
                        }}
                      >
                        <ChatLabel chat={chat} now={now} />
                      </button>
                      <div className="chat-list-actions">
                        <button
                          type="button"
                          className="icon-button"
                          role="menuitem"
                          aria-label="Rename chat"
                          title="Rename chat"
                          disabled={saving}
                          onClick={() =>
                            setEdit({
                              kind: "rename",
                              id: chat.id,
                              title: chat.title,
                            })
                          }
                        >
                          <PencilSimple />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          role="menuitem"
                          aria-label="Delete chat"
                          title={working ? "Stop the run first" : "Delete chat"}
                          disabled={working || saving}
                          onClick={() =>
                            setEdit({ kind: "delete", id: chat.id })
                          }
                        >
                          <Trash />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
            {chats.length > 0 && <hr role="separator" />}
            <button
              type="button"
              role="menuitem"
              data-menu-row=""
              data-menu-label="New chat"
              onClick={newChat}
            >
              <Plus /> New chat
            </button>
            <button
              type="button"
              role="menuitem"
              data-menu-row="t3"
              data-menu-label="Link a T3 Code thread"
              onClick={() => showView("t3")}
            >
              <LinkSimple /> Link a T3 Code thread
            </button>
            <button
              type="button"
              role="menuitem"
              data-menu-row="native"
              data-menu-label="Continue a session"
              onClick={() => showView("native")}
            >
              <Terminal /> Continue a session
            </button>
            <button
              type="button"
              role="menuitem"
              data-menu-row=""
              data-menu-label="Refresh agents"
              disabled={refreshDisabled}
              onClick={() => {
                close(true);
                onRefresh();
              }}
            >
              <ArrowClockwise /> Refresh agents
            </button>
          </>
        )}
      </div>
    </div>
  );
});
