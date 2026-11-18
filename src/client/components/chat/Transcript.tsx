import { createContext, memo, useContext, useId, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { CaretRight } from "@phosphor-icons/react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentMessage, AgentProvider } from "../../../shared/agent";
import type { Project } from "../../../shared/project";
import {
  describeTool,
  editsProject,
  failureReason,
  hiddenTools,
  summarizeSteps,
  targetsFile,
} from "../../../shared/toolRow";
import { TimecodeText } from "../TimecodeText";
import { chatClock } from "./clock";
import { CodeBlock } from "./CodeBlock";
import { Attachments } from "./Attachments";

const ToolRow = memo(function ToolRow({ message }: { message: AgentMessage }) {
  const { verb, object } = describeTool(
    message,
    message.status === "streaming" ? "active" : "done",
  );
  const edit = editsProject(message.tool);
  const target = message.target?.trim();
  // A saved edit's summary includes its target and the result in one sentence.
  const targetAt =
    edit && message.summary && target ? object.indexOf(target) : -1;
  const subjectEnd =
    targetAt < 0 ? object.length : targetAt + (target?.length ?? 0);
  const reason = message.status === "failed" ? failureReason(message) : "";
  return (
    <div
      className="chat-step"
      data-status={message.status}
      data-edit={edit || undefined}
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
            <bdi>{object.slice(0, subjectEnd)}</bdi>
            {subjectEnd < object.length && (
              <span className="chat-tool-detail">
                {object.slice(subjectEnd)}
              </span>
            )}
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
  const [grouped, setGrouped] = useState(false);
  const rows = useId();
  const { summary, running, shown } = summarizeSteps(steps, grouped);
  // Once formed, keep the disclosure and its focus even if every routine call fails.
  if (summary && !grouped) setGrouped(true);
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

const markdownPlugins = [remarkGfm];
const timecode = /^\d+:\d{2}(?::\d{2}){0,2}$/;

const MessageComplete = createContext(false);
const markdownComponents: Components = {
  pre: function MarkdownCode({ node, children }) {
    const complete = useContext(MessageComplete);
    const code = node?.children[0];
    if (code?.type !== "element" || code.tagName !== "code")
      return <pre>{children}</pre>;
    const classes = code.properties.className;
    const language = Array.isArray(classes)
      ? (classes
          .find(
            (value): value is string =>
              typeof value === "string" && value.startsWith("language-"),
          )
          ?.slice(9)
          .toLowerCase() ?? "")
      : "";
    const text = code.children
      .map((child) => (child.type === "text" ? child.value : ""))
      .join("");
    return <CodeBlock text={text} language={language} complete={complete} />;
  },
  td: ({ node, children, ...props }) => {
    if (typeof children === "string" && timecode.test(children))
      return (
        <td {...props} className="mono chat-timecode">
          <TimecodeText timecode={children} />
        </td>
      );
    return <td {...props}>{children}</td>;
  },
};

const Message = memo(function Message({
  message,
  provider,
  project,
}: {
  message: AgentMessage;
  provider: AgentProvider;
  project: Pick<Project, "id" | "path">;
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
        <MessageComplete.Provider value={message.status !== "streaming"}>
          <Markdown
            remarkPlugins={markdownPlugins}
            components={markdownComponents}
          >
            {message.text}
          </Markdown>
        </MessageComplete.Provider>
      </div>
      {message.role === "user" && Boolean(message.attachments?.length) && (
        <Attachments project={project} files={message.attachments ?? []} />
      )}
    </article>
  );
});

const noMessages: readonly AgentMessage[] = [];

const Turn = memo(
  function Turn({
    messages,
    start,
    end,
    provider,
    project,
    finished,
  }: {
    messages: readonly AgentMessage[];
    start: number;
    end: number;
    provider: AgentProvider;
    project: Pick<Project, "id" | "path">;
    finished: boolean;
  }) {
    const turn = messages.slice(start, end);
    const blocks: AgentMessage[][] = [];
    for (const message of turn) {
      if (message.role === "tool" && hiddenTools.has(message.tool ?? ""))
        continue;
      if (
        message.role !== "tool" &&
        !message.text.trim() &&
        !(message.role === "user" && message.attachments?.length)
      )
        continue;
      const last = blocks.at(-1);
      if (message.role === "tool" && last?.[0]?.role === "tool")
        last.push(message);
      else blocks.push([message]);
    }
    const first = turn[0];
    const last = turn.at(-1);
    const from = first?.role === "user" ? Date.parse(first.createdAt) : 0;
    const to = last ? Date.parse(last.createdAt) : 0;
    const seconds = Math.floor((to - from) / 1000);
    return (
      <>
        {blocks.map((steps) => {
          const first = steps[0];
          if (!first) return null;
          return first.role === "tool" ? (
            <StepGroup key={first.id} steps={steps} />
          ) : (
            <Message
              key={first.id}
              message={first}
              provider={provider}
              project={project}
            />
          );
        })}
        {finished && from !== 0 && to !== 0 && seconds > 0 && (
          <div className="chat-worked mono">Worked {chatClock(seconds)}</div>
        )}
      </>
    );
  },
  (before, after) => {
    if (
      before.start !== after.start ||
      before.end !== after.end ||
      before.provider !== after.provider ||
      before.project !== after.project ||
      before.finished !== after.finished
    )
      return false;
    // Deltas replace their message and preserve the other message objects.
    for (let index = after.start; index < after.end; index++)
      if (before.messages[index] !== after.messages[index]) return false;
    return true;
  },
);

export const Transcript = memo(function Transcript({
  project,
  messages = noMessages,
  provider,
  busy,
  problem,
  messagesRef,
  followRef,
  children,
}: {
  project: Pick<Project, "id" | "path">;
  messages?: readonly AgentMessage[];
  provider: AgentProvider;
  busy: boolean;
  problem?: string;
  messagesRef: RefObject<HTMLDivElement | null>;
  followRef: RefObject<boolean>;
  children?: ReactNode;
}) {
  const turns = [];
  let start = 0;
  for (let end = 1; end <= messages.length; end++) {
    if (end < messages.length && messages[end]?.role !== "user") continue;
    turns.push(
      <Turn
        key={messages[start]?.id}
        project={project}
        messages={messages}
        start={start}
        end={end}
        provider={provider}
        finished={end < messages.length || !busy}
      />,
    );
    start = end;
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
      {!messages.length && problem && <p className="chat-empty">{problem}</p>}
      {turns}
      {children}
    </div>
  );
});
