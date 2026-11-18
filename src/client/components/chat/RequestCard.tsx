import { useId, useMemo, useState } from "react";
import type { AgentRequest } from "../../../shared/agent";
import {
  CUTROOM_SERVER,
  parseTool,
  runsCommand,
} from "../../../shared/toolRow";
import { CommandBatchSchema } from "../../../shared/timeline/schema";
import { apply, TimelineError } from "../../../shared/timeline/apply";
import { editLabel } from "../../../shared/timeline/labels";
import { useTimeline } from "../../edit/timeline";

export function RequestCard({
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
  const batch = useMemo(() => {
    const { server, name } = parseTool(request.tool);
    if (
      request.kind !== "approval" ||
      server !== CUTROOM_SERVER ||
      name !== "timeline_edit"
    )
      return undefined;
    return CommandBatchSchema.safeParse(request.input).data;
  }, [request]);
  const timeline = useTimeline((state) =>
    batch &&
    state.projectId === request.input.projectId &&
    state.view?.composition === batch.composition
      ? state.view.timeline
      : undefined,
  );
  const commands = useMemo(() => {
    let before = timeline;
    return batch?.commands.map((command) => {
      const label = editLabel([command], before, "Edit", "pending");
      // Later commands describe the result of earlier commands in this same batch.
      if (before) {
        try {
          before = apply(before, command);
        } catch (error) {
          if (!(error instanceof TimelineError)) throw error;
          before = undefined;
        }
      }
      return label;
    });
  }, [batch, timeline]);
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
        className={
          question ? "text-button" : "secondary-button agent-request-allow"
        }
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
          {commands ? (
            <ul className="agent-request-commands" id={title}>
              {commands.map((command, index) => (
                <li key={index}>{command}</li>
              ))}
            </ul>
          ) : (
            <p className="agent-request-title" id={title}>
              {request.title}
            </p>
          )}
          {/* A command is the thing being approved, so it is read in full. */}
          {runsCommand(request.tool) && request.target && (
            <pre className="agent-request-command">{request.target}</pre>
          )}
          {!commands && request.detail && (
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
