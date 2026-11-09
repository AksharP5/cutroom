import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type TranscriptJob,
  type TranscriptView,
} from "../../shared/project";
import { ApiError, api, json, timecode } from "../api";

const viewsSchema = z.object({ transcripts: z.array(TranscriptViewSchema) });
function readJob(projectId: string) {
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(`cutroom:transcription:${projectId}`) ?? "null",
    );
    const parsed = TranscriptJobSchema.safeParse(value);
    return parsed.success &&
      parsed.data.projectId === projectId &&
      parsed.data.status === "running"
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}

const clipKey = (clip: Pick<MediaClip, "sourceFile" | "elementId">) =>
  `${clip.sourceFile}:${clip.elementId}`;

type TranscriptWord = TranscriptView["words"][number];

const TranscriptChunk = memo(
  function TranscriptChunk({
    words,
    selectedIds,
    onWordClick,
  }: {
    words: TranscriptWord[];
    selectedIds: ReadonlySet<string>;
    onWordClick: (word: TranscriptWord, extend: boolean) => void;
  }) {
    return (
      <div className="transcript-chunk">
        {words.map((word) => (
          <button
            key={word.id}
            className={`${selectedIds.has(word.id) ? "word-selected" : ""} ${word.cut ? "word-cut" : ""}`}
            title={
              word.timelineStart === null
                ? "Cut from the timeline"
                : timecode(word.timelineStart)
            }
            aria-pressed={selectedIds.has(word.id)}
            onClick={(event) => onWordClick(word, event.shiftKey)}
          >
            {word.text}{" "}
          </button>
        ))}
      </div>
    );
  },
  (before, after) =>
    before.words === after.words &&
    before.onWordClick === after.onWordClick &&
    before.words.every(
      (word) =>
        before.selectedIds.has(word.id) === after.selectedIds.has(word.id),
    ),
);

export const ScriptPanel = memo(function ScriptPanel({
  projectId,
  revision,
  visible,
  onChange,
  onSeek,
  onAsk,
}: {
  projectId: string;
  revision: string;
  visible: boolean;
  onChange: () => Promise<void>;
  onSeek: (time: number, compositionPath?: string) => void;
  onAsk: (prompt: string) => void;
}) {
  const [media, setMedia] = useState<MediaClip[]>([]);
  const [views, setViews] = useState<TranscriptView[]>([]);
  const [selectedClipKey, setSelectedClipKey] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [job, setJob] = useState<TranscriptJob | null>(() =>
    readJob(projectId),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const anchor = useRef<string | null>(null);
  const pendingTranscript = useRef<string | null>(null);

  const refreshRequest = useRef<AbortController | null>(null);
  const recordJob = useCallback(
    (value: TranscriptJob | null) => {
      if (value?.status === "running") pendingTranscript.current = null;
      if (value?.status === "complete" && value.transcriptId)
        pendingTranscript.current = value.transcriptId;
      try {
        const key = `cutroom:transcription:${projectId}`;
        if (value?.status === "running")
          sessionStorage.setItem(key, JSON.stringify(value));
        else sessionStorage.removeItem(key);
      } catch {
        /* The current job still works when browser storage is disabled. */
      }
      setJob(value);
    },
    [projectId],
  );

  const refresh = useCallback(async () => {
    refreshRequest.current?.abort();
    const request = new AbortController();
    refreshRequest.current = request;
    try {
      const [clips, scripts] = await Promise.all([
        api(`/projects/${projectId}/media`, MediaListSchema, {
          signal: request.signal,
        }),
        api(`/projects/${projectId}/transcripts`, viewsSchema, {
          signal: request.signal,
        }),
      ]);
      if (request.signal.aborted) return;
      setMedia(clips.media);
      setViews(scripts.transcripts);
      const completed = scripts.transcripts.find(
        (transcript) => transcript.id === pendingTranscript.current,
      );
      if (completed) {
        setSelectedClipKey(clipKey(completed));
        pendingTranscript.current = null;
      }
    } catch (error) {
      if (!request.signal.aborted) throw error;
    }
  }, [projectId]);

  useEffect(() => {
    if (!visible) return;
    void refresh().catch((error: unknown) =>
      setError(error instanceof Error ? error.message : String(error)),
    );
    return () => refreshRequest.current?.abort();
  }, [visible, refresh, revision]);
  useEffect(() => () => refreshRequest.current?.abort(), []);

  const clips = useMemo(() => {
    const all = new Map(media.map((clip) => [clipKey(clip), clip]));
    for (const transcript of views) {
      const key = clipKey(transcript);
      if (!all.has(key))
        all.set(key, {
          elementId: transcript.elementId,
          sourceFile: transcript.sourceFile,
          mediaPath: transcript.mediaPath,
          label: transcript.mediaPath.split("/").at(-1) ?? transcript.mediaPath,
          kind: "video",
          start: transcript.original.start,
          duration: transcript.duration,
        });
    }
    return [...all.values()];
  }, [media, views]);
  const selectedIds = useMemo(() => new Set(selected), [selected]);
  const selectedClip =
    clips.find((clip) => clipKey(clip) === selectedClipKey) ?? clips[0];
  const active = views.find(
    (transcript) =>
      selectedClip && clipKey(transcript) === clipKey(selectedClip),
  );
  const selectedWords = useMemo(
    () => active?.words.filter((word) => selectedIds.has(word.id)) ?? [],
    [active, selectedIds],
  );
  const chunks = useMemo(() => {
    const all: TranscriptWord[][] = [];
    if (active)
      for (let index = 0; index < active.words.length; index += 80)
        all.push(active.words.slice(index, index + 80));
    return all;
  }, [active?.words]);
  const onWordClick = useCallback(
    (word: TranscriptWord, extend: boolean) => {
      if (!active) return;
      if (word.timelineStart !== null)
        onSeek(word.timelineStart, active.sourceFile);
      if (extend && anchor.current) {
        const from = active.words.findIndex(
          (item) => item.id === anchor.current,
        );
        const to = active.words.findIndex((item) => item.id === word.id);
        setSelected(
          active.words
            .slice(Math.min(from, to), Math.max(from, to) + 1)
            .map((item) => item.id),
        );
        return;
      }
      anchor.current = word.id;
      setSelected([word.id]);
    },
    [active, onSeek],
  );

  useEffect(() => {
    setSelected([]);
    anchor.current = null;
  }, [active?.id]);
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const id = job.id;
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let delay = 750;
      let again = true;
      try {
        const result = await api(
          `/transcription-jobs/${id}`,
          TranscriptJobSchema,
          { signal: request.signal },
        );
        if (request.signal.aborted) return;
        recordJob(result);
        setPollError("");
        again = result.status === "running";
        if (result.status === "complete") await onChange();
        if (result.status === "failed")
          setError(result.error ?? result.message);
      } catch (error) {
        if (request.signal.aborted) return;
        if (error instanceof ApiError && error.status === 404) {
          recordJob(null);
          again = false;
        }
        setPollError(error instanceof Error ? error.message : String(error));
        delay = 2000;
      }
      if (again && !request.signal.aborted)
        timer = setTimeout(() => void poll(), delay);
    }
    timer = setTimeout(() => void poll(), 500);
    return () => {
      request.abort();
      clearTimeout(timer);
    };
  }, [job?.id, job?.status, onChange, recordJob]);

  async function transcribe() {
    if (!selectedClip || busy || job?.status === "running") return;
    setBusy(true);
    setError("");
    setPollError("");
    try {
      recordJob(
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
    if (!active || !selected.length || busy) return;
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
          disabled={busy}
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
            disabled={!selectedClip || busy}
            onClick={() => fileInput.current?.click()}
          >
            <FileArrowUp size={14} />
            Import transcript
          </button>
          <button
            className="icon-button"
            aria-label="Refresh media clips"
            disabled={busy}
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
            if (!file || !selectedClip || busy) return;
            setBusy(true);
            setError("");
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
                const imported = await api(
                  `/projects/${projectId}/transcripts/import`,
                  TranscriptViewSchema,
                  json("POST", {
                    ...selectedClip,
                    words: Array.isArray(parsed) ? parsed : parsed.words,
                  }),
                );
                setSelectedClipKey(clipKey(imported));
                await onChange();
              })
              .catch((error: unknown) =>
                setError(
                  error instanceof Error ? error.message : String(error),
                ),
              )
              .finally(() => setBusy(false));
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
            disabled={busy}
            onClick={() =>
              void api(
                `/transcription-jobs/${job.id}`,
                TranscriptJobSchema,
                json("DELETE"),
              )
                .then(recordJob)
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
      {(error || pollError) && (
        <div className="inline-error" role="alert">
          <p>{error || pollError}</p>
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
            {chunks.map((words) => (
              <TranscriptChunk
                key={words[0]?.id}
                words={words}
                selectedIds={selectedIds}
                onWordClick={onWordClick}
              />
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
});
