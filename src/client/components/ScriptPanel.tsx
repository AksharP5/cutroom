import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  FileArrowUp,
  Scissors,
  TextAlignLeft,
  Waveform,
  X,
} from "@phosphor-icons/react";
import { z } from "zod";
import {
  MediaListSchema,
  SourceSchema,
  TranscriptJobSchema,
  TranscriptViewSchema,
  WordSchema,
  type MediaClip,
  type Transcript,
  type TranscriptJob,
  type TranscriptView,
} from "../../shared/project";
import { api, json, timecode } from "../api";

const viewsSchema = z.object({ transcripts: z.array(TranscriptViewSchema) });
const clipKey = (clip: Pick<MediaClip, "sourceFile" | "elementId">) =>
  `${clip.sourceFile}:${clip.elementId}`;

export function ScriptPanel({
  projectId,
  transcripts,
  onChange,
  onSeek,
  onAsk,
}: {
  projectId: string;
  transcripts: Transcript[];
  onChange: () => Promise<void>;
  onSeek: (time: number) => void;
  onAsk: (prompt: string) => void;
}) {
  const [media, setMedia] = useState<MediaClip[]>([]);
  const [views, setViews] = useState<TranscriptView[]>([]);
  const [selectedClipKey, setSelectedClipKey] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [job, setJob] = useState<TranscriptJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const anchor = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const [clips, scripts] = await Promise.all([
      api(`/projects/${projectId}/media`, MediaListSchema),
      api(`/projects/${projectId}/transcripts`, viewsSchema),
    ]);
    setMedia(clips.media);
    setViews(scripts.transcripts);
  }, [projectId]);

  useEffect(() => {
    let active = true;
    void refresh().catch((error: unknown) => {
      if (active)
        setError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      active = false;
    };
  }, [refresh, transcripts]);

  const clips = useMemo(() => {
    const all = [...media];
    for (const transcript of views) {
      if (!all.some((clip) => clipKey(clip) === clipKey(transcript)))
        all.push({
          elementId: transcript.elementId,
          sourceFile: transcript.sourceFile,
          mediaPath: transcript.mediaPath,
          label: transcript.mediaPath.split("/").at(-1) ?? transcript.mediaPath,
          kind: "video",
          start: transcript.original.start,
          duration: transcript.duration,
        });
    }
    return all;
  }, [media, views]);
  const selectedClip =
    clips.find((clip) => clipKey(clip) === selectedClipKey) ?? clips[0];
  const active = views.find(
    (transcript) =>
      selectedClip && clipKey(transcript) === clipKey(selectedClip),
  );
  const selectedWords =
    active?.words.filter((word) => selected.includes(word.id)) ?? [];

  useEffect(() => {
    setSelected([]);
    anchor.current = null;
  }, [active?.id]);
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const id = job.id;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await api(
          `/transcription-jobs/${id}`,
          TranscriptJobSchema,
        );
        if (cancelled) return;
        setJob(result);
        if (result.status === "complete") {
          await onChange();
          await refresh();
          return;
        }
        if (result.status === "failed") {
          setError(result.error ?? result.message);
          return;
        }
        if (result.status === "running")
          timer = setTimeout(() => void poll(), 750);
      } catch (error) {
        if (!cancelled)
          setError(error instanceof Error ? error.message : String(error));
      }
    }
    timer = setTimeout(() => void poll(), 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [job?.id, job?.status, onChange, refresh]);

  async function transcribe() {
    if (!selectedClip) return;
    setBusy(true);
    setError("");
    try {
      setJob(
        await api(
          `/projects/${projectId}/transcribe`,
          TranscriptJobSchema,
          json("POST", selectedClip),
        ),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function cut(action: "cut" | "restore") {
    if (!active || !selected.length) return;
    setBusy(true);
    setError("");
    try {
      const source = await api(
        `/projects/${projectId}/source?path=${encodeURIComponent(active.sourceFile)}`,
        SourceSchema,
      );
      await api(
        `/projects/${projectId}/transcripts/${active.id}/cuts`,
        TranscriptViewSchema,
        json("POST", {
          wordIds: selected,
          action,
          expectedVersion: source.version,
        }),
      );
      await onChange();
      await refresh();
      setSelected([]);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function askAboutSelection() {
    if (!active || !selectedWords.length) return;
    const time =
      selectedWords.find((word) => word.timelineStart !== null)
        ?.timelineStart ?? active.original.start;
    onAsk(
      `At ${timecode(time)}, about this passage from ${active.mediaPath} in ${active.sourceFile}:\n\n"${selectedWords.map((word) => word.text).join(" ")}"\n\n`,
    );
  }

  return (
    <section
      className="script-panel"
      aria-label="Script editor"
      onKeyDown={(event) => {
        if (
          !selected.length ||
          !(event.key === "Delete" || event.key === "Backspace") ||
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        void cut("cut");
      }}
    >
      <div className="script-controls">
        <label className="field-label" htmlFor="script-media">
          Footage
        </label>
        <select
          id="script-media"
          value={selectedClip ? clipKey(selectedClip) : ""}
          onChange={(event) => {
            setSelectedClipKey(event.target.value);
            setSelected([]);
            setError("");
          }}
        >
          {!clips.length && <option value="">No audio or video clips</option>}
          {clips.map((clip) => (
            <option value={clipKey(clip)} key={clipKey(clip)}>
              {clip.label}
            </option>
          ))}
        </select>
        {!active && (
          <button
            className="primary-button"
            disabled={!selectedClip || busy || job?.status === "running"}
            onClick={() => void transcribe()}
          >
            <Waveform />
            {busy || job?.status === "running"
              ? "Transcribing…"
              : "Transcribe locally"}
          </button>
        )}
        <div className="script-file-actions">
          <button
            className="text-button"
            disabled={!selectedClip}
            onClick={() => fileInput.current?.click()}
          >
            <FileArrowUp size={14} />
            Import transcript
          </button>
          <button
            className="icon-button"
            aria-label="Refresh media clips"
            onClick={() =>
              void refresh().catch((error: unknown) =>
                setError(
                  error instanceof Error ? error.message : String(error),
                ),
              )
            }
          >
            <ArrowClockwise size={14} />
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file || !selectedClip) return;
            void file
              .text()
              .then(async (text) => {
                const value: unknown = JSON.parse(text);
                const parsed = z
                  .union([
                    z.array(WordSchema),
                    z.object({ words: z.array(WordSchema) }),
                  ])
                  .parse(value);
                await api(
                  `/projects/${projectId}/transcripts/import`,
                  TranscriptViewSchema,
                  json("POST", {
                    ...selectedClip,
                    words: Array.isArray(parsed) ? parsed : parsed.words,
                  }),
                );
                await onChange();
                await refresh();
              })
              .catch((error: unknown) =>
                setError(
                  error instanceof Error ? error.message : String(error),
                ),
              );
            event.target.value = "";
          }}
        />
      </div>
      {job?.status === "running" && (
        <div className="transcription-status">
          <span>{job.message}</span>
          <progress max={1} value={job.progress} />
          <button
            className="text-button"
            onClick={() =>
              void api(
                `/transcription-jobs/${job.id}`,
                TranscriptJobSchema,
                json("DELETE"),
              )
                .then(setJob)
                .catch((error: unknown) =>
                  setError(
                    error instanceof Error ? error.message : String(error),
                  ),
                )
            }
          >
            <X size={13} />
            Cancel
          </button>
        </div>
      )}
      {error && (
        <div className="inline-error" role="alert">
          <p>{error}</p>
          {selectedWords.length > 0 && (
            <button className="text-button" onClick={askAboutSelection}>
              Ask agent about this edit
            </button>
          )}
        </div>
      )}
      {!active && (
        <div className="small-empty">
          <TextAlignLeft size={26} weight="light" />
          <h3>Edit with words.</h3>
          <p>
            Add a video or audio clip to the timeline, then transcribe it.
            Select words to cut, restore, or discuss with your agent.
          </p>
          <small>Original media stays untouched.</small>
        </div>
      )}
      {active && (
        <>
          <div className="script-meta">
            <span>{active.mediaPath.split("/").at(-1)}</span>
            <span>{active.words.length} words</span>
          </div>
          <div className="transcript-words" aria-label="Transcript words">
            {active.words.map((word) => (
              <button
                key={word.id}
                className={`${selected.includes(word.id) ? "word-selected" : ""} ${word.cut ? "word-cut" : ""}`}
                title={
                  word.timelineStart === null
                    ? "Cut from the timeline"
                    : timecode(word.timelineStart)
                }
                aria-pressed={selected.includes(word.id)}
                onClick={(event) => {
                  if (word.timelineStart !== null) onSeek(word.timelineStart);
                  if (event.shiftKey && anchor.current) {
                    const from = active.words.findIndex(
                      (item) => item.id === anchor.current,
                    );
                    const to = active.words.findIndex(
                      (item) => item.id === word.id,
                    );
                    setSelected(
                      active.words
                        .slice(Math.min(from, to), Math.max(from, to) + 1)
                        .map((item) => item.id),
                    );
                  } else {
                    anchor.current = word.id;
                    setSelected([word.id]);
                  }
                }}
              >
                {word.text}{" "}
              </button>
            ))}
          </div>
          <p className="script-hint">
            Select a word. Shift-click to select a passage.
          </p>
        </>
      )}
      {selectedWords.length > 0 && (
        <div className="script-selection-bar">
          <span>
            {selectedWords.length}{" "}
            {selectedWords.length === 1 ? "word" : "words"}
          </span>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void cut("cut")}
          >
            <Scissors size={14} />
            Cut
          </button>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void cut("restore")}
          >
            Restore
          </button>
          <button className="text-button" onClick={askAboutSelection}>
            Ask agent
          </button>
          <button className="text-button" onClick={() => setSelected([])}>
            Clear
          </button>
        </div>
      )}
    </section>
  );
}
