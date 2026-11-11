import { useEffect, useMemo, useRef, useState } from "react";
import { Microphone, Record, Stop } from "@phosphor-icons/react";
import { useStore } from "zustand";
import type { audioLevels } from "../edit/levels";
import { AudioMeters } from "../timeline/meters";
import type { Track } from "../../shared/timeline/schema";
import {
  actionFor,
  comboOf,
  hint,
  isTyping,
  keymap,
  useKeymap,
} from "../keymap";
import { Modal } from "../components/Modal";
import { SelectMenu } from "../components/SelectMenu";
import { useWorkspace } from "../workspace";
import { createVoiceoverSession } from "./session";
import type { VoiceoverSession } from "./session";
import "./voiceover.css";

export function useVoiceover(projectId: string) {
  const session = useMemo(() => createVoiceoverSession(projectId), [projectId]);
  useEffect(() => {
    session.activate();
    useWorkspace.setState({ beforeProjectChange: session.canLeave });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (session.canLeave()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const press = (event: KeyboardEvent) => {
      const { state } = session.store.getState();
      if (state.kind !== "recording") return;
      const combo = comboOf(event);
      if (
        ["Esc", "Space", ...keymap.cutroomRecordVoiceover.keys, "K"].includes(
          combo ?? "",
        )
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) void session.stop(combo === "Esc");
        return;
      }
      // Editing or shuttling during a take changes what is being narrated.
      if (!isTyping(event.target) && actionFor(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", press, true);
    window.addEventListener("beforeunload", beforeUnload);
    const devices = () => void session.refreshDevices().catch(() => {});
    navigator.mediaDevices?.addEventListener("devicechange", devices);
    return () => {
      window.removeEventListener("keydown", press, true);
      window.removeEventListener("beforeunload", beforeUnload);
      useWorkspace.setState({ beforeProjectChange: null });
      navigator.mediaDevices?.removeEventListener("devicechange", devices);
      session.dispose();
    };
  }, [session]);
  useKeymap({ cutroomRecordVoiceover: session.toggleRecord });
  return session;
}

function InputLevel({ session }: { session: VoiceoverSession }) {
  const source = useMemo(
    () => ({
      subscribe(listener: Parameters<typeof audioLevels.subscribe>[0]) {
        return session.subscribeLevel((peak) =>
          listener({ l: peak, r: peak, playing: true }),
        );
      },
    }),
    [session],
  );
  return <AudioMeters source={source} compact label="Microphone input level" />;
}

export function VoiceoverTransport({ session }: { session: VoiceoverSession }) {
  const state = useStore(session.store, ({ state }) => state);
  const recording = state.kind === "recording";
  const discard = useStore(session.store, ({ discard }) => discard);
  const button = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (discard === "recording") returnFocus.current = true;
    if (state.kind === "save-failed") returnFocus.current = false;
    if (
      returnFocus.current &&
      (state.kind === "armed" || state.kind === "idle")
    ) {
      returnFocus.current = false;
      button.current?.focus({ preventScroll: true });
    }
  }, [discard, state.kind]);
  return (
    <>
      <button
        ref={button}
        className={`edit-icon vo-record${recording ? " recording" : ""}`}
        aria-label={recording ? "Stop voiceover" : "Record voiceover"}
        aria-pressed={recording}
        disabled={state.kind === "arming" || state.kind === "saving"}
        title={hint("cutroomRecordVoiceover")}
        onClick={session.toggleRecord}
      >
        {recording ? (
          <Stop size={14} weight="fill" />
        ) : (
          <Record size={16} weight="fill" />
        )}
      </button>
      <DiscardTake session={session} source="recording" />
    </>
  );
}

function DiscardTake({
  session,
  source,
}: {
  session: VoiceoverSession;
  source: "recording" | "unsaved";
}) {
  const discard = useStore(session.store, ({ discard }) => discard);
  const keepButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (discard === source) keepButton.current?.focus({ preventScroll: true });
  }, [discard, source]);
  if (discard !== source) return null;
  const keep = () => session.answerDiscard(false);
  return (
    <Modal title="Discard voiceover take?" onClose={keep}>
      <p className="vo-discard-message">
        {source === "recording"
          ? "Discard this recording or save it to the timeline."
          : "This take has not been saved. Discarding it cannot be undone."}
      </p>
      <footer className="modal-actions">
        <button ref={keepButton} className="secondary-button" onClick={keep}>
          {source === "recording" ? "Save take" : "Keep take"}
        </button>
        <button
          className="secondary-button vo-discard"
          onClick={() => session.answerDiscard(true)}
        >
          Discard take
        </button>
      </footer>
    </Modal>
  );
}

export function VoiceoverRecordMark({
  session,
}: {
  session: VoiceoverSession;
}) {
  const recording = useStore(
    session.store,
    ({ state }) => state.kind === "recording",
  );
  return recording ? (
    <span className="vo-record-mark" role="status">
      <Record size={12} weight="fill" />
      Recording
    </span>
  ) : null;
}

export function VoiceoverHeader({
  session,
  track,
  id,
  part,
}: {
  session: VoiceoverSession;
  track: Track;
  id: string;
  part: "title" | "buttons";
}) {
  const { state, devices, device, error, inputLatency, compensation } =
    useStore(session.store);
  const active = state.kind !== "idle" && state.track.index === track.index;
  const recording = active && state.kind === "recording";
  const busy =
    state.kind === "recording" ||
    state.kind === "saving" ||
    state.kind === "arming" ||
    state.kind === "save-failed";
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const openPanel = () => {
    const box = input.current?.getBoundingClientRect();
    if (!box) return;
    setPosition({ left: box.right, top: Math.max(4, box.top - 240) });
    panel.current?.showPopover();
    const target = panel.current?.querySelector<HTMLButtonElement>(
      ".select-trigger:not(:disabled), .primary-button:not(:disabled)",
    );
    (target ?? panel.current)?.focus({ preventScroll: true });
    void session.refreshDevices().catch(() => {});
  };
  useEffect(() => {
    if (part === "title" && active && state.kind === "save-failed") openPanel();
  }, [part, active, state.kind]);
  if (part === "buttons")
    return (
      <button
        className={`tl-track-button vo-arm${active ? " armed" : ""}`}
        aria-label={`Arm ${id}`}
        aria-pressed={active}
        title="Arm microphone track. Takes stop after 30 minutes."
        disabled={(!active && track.locked) || busy}
        onClick={() => session.toggleArm(track)}
      >
        R
      </button>
    );
  return (
    <>
      {active && <InputLevel session={session} />}
      <button
        ref={input}
        className={`vo-input${active && state.kind === "save-failed" ? " vo-recover" : ""}`}
        aria-label={`Microphone input ${id}`}
        title={
          state.kind === "save-failed" && active
            ? "Recover voiceover take"
            : "Choose microphone"
        }
        onClick={openPanel}
      >
        <Microphone size={12} />
      </button>
      <div
        ref={panel}
        popover="auto"
        role="dialog"
        aria-label={`Voiceover ${id}`}
        tabIndex={-1}
        className="vo-input-panel"
        style={position}
      >
        <strong>
          Voiceover {id}
          {recording ? " · Recording" : ""}
        </strong>
        <label>
          Input
          <SelectMenu
            label="Voiceover input device"
            value={device}
            disabled={busy}
            onChange={(value) => void session.arm(track, value)}
            options={[
              { value: "", label: "System default" },
              ...(device && !devices.some((input) => input.deviceId === device)
                ? [{ value: device, label: "Saved input unavailable" }]
                : []),
              ...devices
                .filter((input) => input.deviceId)
                .map((input, index) => ({
                  value: input.deviceId,
                  label: input.label || `Microphone ${index + 1}`,
                })),
            ]}
          />
          {active && <InputLevel session={session} />}
        </label>
        {active && (
          <p title="Input delay plus playback output delay, removed from the beginning of the take.">
            {inputLatency === null
              ? "Input delay not reported"
              : `Input delay ${Math.round(inputLatency * 1000)} ms`}
            <br />
            Latency compensation {Math.round(compensation * 1000)} ms
          </p>
        )}
        <p>
          Overlaps use the first audio track with room. Esc asks to discard the
          take.
        </p>
        {error && <p role="alert">{error}</p>}
        {active && state.kind === "save-failed" ? (
          <div className="vo-actions">
            <button className="primary-button" onClick={session.retry}>
              Retry save
            </button>
            <button className="secondary-button" onClick={session.download}>
              Download take
            </button>
            <button
              className="secondary-button vo-discard"
              onClick={session.discardUnsaved}
            >
              Discard take
            </button>
          </div>
        ) : (
          <button
            className="primary-button"
            title={hint("cutroomRecordVoiceover")}
            disabled={busy && !recording}
            onClick={() => {
              if (active) session.toggleRecord();
              else session.toggleArm(track);
            }}
          >
            {recording ? "Stop and save" : active ? "Record" : "Arm track"}
            {active && !recording && (
              <kbd>{keymap.cutroomRecordVoiceover.keys[0]}</kbd>
            )}
          </button>
        )}
        {active && <DiscardTake session={session} source="unsaved" />}
      </div>
    </>
  );
}
