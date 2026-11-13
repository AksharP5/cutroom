import { audioGainToDb } from "@hyperframes/core/audio-gain";
import { toFrames } from "./apply";
import { isAudioKind } from "./schema";
import type { Clip, Command, Timeline } from "./schema";
import { formatTimecode } from "./timecode";

/** A clip's name as the timeline shows it. */
export const clipName = (clip: Pick<Clip, "id" | "label" | "src">) =>
  clip.label ?? clip.src?.split("/").at(-1) ?? clip.id;

/** Percentages keep every digit the engine stores (six decimals of the fraction). */
export const formatPercent = (value: number) =>
  `${Number((value * 100).toFixed(4))}%`;

/** Command sentences shared by history, the inspector and pending agent approvals. */
export function editLabel(
  commands: Command[],
  timeline: Timeline | undefined,
  fallback: string,
  tense: "past" | "pending" = "past",
): string {
  const pending = tense === "pending";
  const time = (frame: number) =>
    timeline ? formatTimecode(frame, timeline.fps) : `frame ${frame}`;
  const clips = timeline?.clips ?? [];
  const target = (ids: readonly string[]) => {
    if (!ids.length) return "auto-selected clips";
    const names = ids.map((id) => {
      const clip = clips.find((clip) => clip.id === id);
      return clip
        ? (clip.label ??
            clip.src?.split("/").at(-1) ??
            `a ${clip.kind === "element" ? "text" : clip.kind} clip`)
        : "a clip";
    });
    return names.length > 2
      ? `${names[0]} and ${names.length - 1} more clips`
      : names.join(" and ");
  };
  const trackName = (index: number) => {
    const track = timeline?.tracks.find((track) => track.index === index);
    if (!track || !timeline) return `track ${index}`;
    return (
      track.name ??
      `${track.kind === "audio" ? "A" : "V"}${timeline.tracks.filter((item) => item.kind === track.kind && item.index <= index).length}`
    );
  };
  const labels = commands.map((command) => {
    switch (command.type) {
      case "move": {
        const parts: string[] = [];
        if (command.by)
          parts.push(
            `${Math.abs(command.by)} ${Math.abs(command.by) === 1 ? "frame" : "frames"} ${command.by > 0 ? "right" : "left"}`,
          );
        if (command.trackBy) {
          const clip = clips.find(
            (item) => item.id === (command.trackClipIds ?? command.clipIds)[0],
          );
          const up =
            command.trackBy > 0 !==
            (clip !== undefined && isAudioKind(clip.kind));
          parts.push(
            `${Math.abs(command.trackBy)} ${Math.abs(command.trackBy) === 1 ? "track" : "tracks"} ${up ? "up" : "down"}`,
          );
        }
        if (pending) {
          const clip =
            command.clipIds.length === 1
              ? clips.find((clip) => clip.id === command.clipIds[0])
              : undefined;
          if (clip && command.by && clip.start + command.by >= 0)
            parts[0] = `to ${time(clip.start + command.by)}`;
          return `Move ${target(command.clipIds)}${parts.length ? ` ${parts.join(" and ")}` : ""}`;
        }
        return `Moved ${parts.join(" and ")}`;
      }
      case "trim":
        return pending
          ? `${command.ripple ? "Ripple trim" : "Trim"} ${command.edge} of ${target([command.clipId])} to ${time(command.to)}`
          : `${command.ripple ? "Ripple trimmed" : "Trimmed"} ${command.edge} to ${time(command.to)}`;
      case "split":
        return `Split${pending ? ` ${target(command.clipIds ?? [])}` : ""} at ${time(command.at)}`;
      case "remove":
        return pending
          ? `${command.ripple ? "Ripple delete" : "Lift"} ${target(command.clipIds)}`
          : command.ripple
            ? "Ripple deleted clips"
            : "Lifted clips";
      case "paste":
        return `${pending ? "Paste" : "Pasted"} clips${pending || command.mode === "insert" ? ` with ${command.mode}` : ""} at ${time(command.at)}`;
      case "insert": {
        const name =
          command.clip.label ??
          command.clip.src.split("/").at(-1) ??
          command.clip.kind;
        if (pending && command.mode === "overwrite") {
          const tracks = [trackName(command.track)];
          if (command.linkedAudio?.track !== undefined)
            tracks.push(trackName(command.linkedAudio.track));
          return `Overwrite ${tracks.join(" and ")} from ${time(command.at)} to ${time(command.at + command.clip.duration)} with ${name}`;
        }
        return pending
          ? `Add ${name} at ${time(command.at)}${command.mode !== "place" ? ` with ${command.mode}` : ""}`
          : `Added ${command.clip.kind} at ${time(command.at)}`;
      }
      case "setClip": {
        const parts: string[] = [];
        if (command.x === null && command.y === null)
          parts.push("Reset position");
        else
          for (const axis of ["x", "y"] as const) {
            const value = command[axis];
            if (value === undefined) continue;
            if (value === null) {
              parts.push(`Reset position ${axis.toUpperCase()}`);
              continue;
            }
            const before =
              clips.find((clip) => clip.id === command.clipId)?.[axis] ?? 0;
            const delta = Number((value - before).toFixed(6));
            if (delta)
              parts.push(
                `${pending ? "Move" : "Moved"} ${Math.abs(delta)} px ${axis === "x" ? (delta > 0 ? "right" : "left") : delta > 0 ? "down" : "up"}`,
              );
          }
        if (command.text !== undefined) {
          const words = command.text.replaceAll("\n", " ");
          parts.push(
            `Set text to “${words.length > 40 ? `${words.slice(0, 40).trimEnd()}…` : words}”`,
          );
        }
        if (command.opacity !== undefined)
          parts.push(
            `Set opacity to ${command.opacity === null ? "Auto" : formatPercent(command.opacity)}`,
          );
        if (command.label !== undefined)
          parts.push(
            command.label === null
              ? `${pending ? "Clear" : "Cleared"} clip name`
              : `${pending ? "Rename" : "Renamed"} to ${command.label}`,
          );
        if (command.volume !== undefined) {
          const db = audioGainToDb(command.volume ?? 1);
          parts.push(
            command.volume === 0
              ? `${pending ? "Silence" : "Silenced"} clip`
              : `Set gain to ${db > 0 ? "+" : ""}${db.toFixed(1)} dB`,
          );
        }
        if (command.fadeIn !== undefined)
          parts.push(`Set fade in to ${time(command.fadeIn)}`);
        if (command.fadeOut !== undefined)
          parts.push(`Set fade out to ${time(command.fadeOut)}`);
        if (command.enabled !== undefined)
          parts.push(
            command.enabled
              ? pending
                ? "Enable clip"
                : "Enabled clip"
              : pending
                ? "Disable clip"
                : "Disabled clip",
          );
        if (pending && command.automation !== undefined)
          parts.push("Clear automation");
        return `${parts.join("; ") || (pending ? fallback : "")}${pending ? ` for ${target([command.clipId])}` : ""}`;
      }
      case "setTiming": {
        const parts: string[] = [];
        if (command.playbackRate !== undefined)
          parts.push(`Set speed to ${formatPercent(command.playbackRate)}`);
        if (command.mediaStart !== undefined)
          parts.push(
            `Set source in to ${timeline ? time(toFrames(command.mediaStart, timeline.fps)) : `${command.mediaStart}s`}`,
          );
        return `${parts.join("; ") || (pending ? fallback : "")}${pending ? ` for ${target([command.clipId])}` : ""}`;
      }
      case "setTrack": {
        const creating =
          timeline !== undefined &&
          !timeline.tracks.some((track) => track.index === command.index);
        if (creating && !pending)
          return `Added ${command.kind ?? "video"} track`;
        const parts: string[] = [];
        if (command.name !== undefined)
          parts.push(
            command.name === null
              ? `${pending ? "Clear" : "Cleared"} track name`
              : `${pending ? "Rename" : "Renamed"} track to ${command.name}`,
          );
        if (command.locked !== undefined)
          parts.push(
            command.locked
              ? `${pending ? "Lock" : "Locked"} track`
              : `${pending ? "Unlock" : "Unlocked"} track`,
          );
        if (command.enabled !== undefined)
          parts.push(
            command.enabled
              ? `${pending ? "Enable" : "Enabled"} track`
              : `${pending ? "Disable" : "Disabled"} track`,
          );
        if (command.autoSelect !== undefined)
          parts.push(
            command.autoSelect
              ? `${pending ? "Enable" : "Enabled"} track auto-select`
              : `${pending ? "Disable" : "Disabled"} track auto-select`,
          );
        if (command.muted !== undefined)
          parts.push(
            command.muted
              ? `${pending ? "Mute" : "Muted"} track`
              : `${pending ? "Unmute" : "Unmuted"} track`,
          );
        if (command.solo !== undefined)
          parts.push(
            command.solo
              ? `${pending ? "Solo" : "Soloed"} track`
              : `${pending ? "Unsolo" : "Unsoloed"} track`,
          );
        if (creating)
          return [
            `Add ${command.kind ?? "video"} track ${command.index}`,
            ...parts,
          ].join("; ");
        return (
          (parts.join("; ") || fallback) +
          (pending && trackName(command.index)
            ? ` ${trackName(command.index)}`
            : "")
        );
      }
      case "removeTrack":
        return pending
          ? `Remove empty ${trackName(command.index)}`
          : "Removed empty track";
      case "setMarker": {
        if (!pending)
          return command.frame === undefined
            ? "Edited marker"
            : `Set marker at ${time(command.frame)}`;
        const marker = timeline?.markers.find(
          (marker) => marker.id === command.id,
        );
        const adding = timeline ? !marker : command.id === undefined;
        const name = adding ? command.name : marker?.name;
        const parts: string[] = [];
        if (!adding && command.name !== undefined)
          parts.push(`name to "${command.name}"`);
        if (!adding && command.frame !== undefined)
          parts.push(`position to ${time(command.frame)}`);
        if (command.note !== undefined) {
          const note = command.note.replace(/\s+/g, " ").trim();
          parts.push(
            note
              ? `note to "${note.length > 80 ? `${note.slice(0, 80).trimEnd()}…` : note}"`
              : "clear note",
          );
        }
        if (command.duration !== undefined)
          parts.push(`duration to ${time(command.duration)}`);
        if (command.color !== undefined)
          parts.push(`color to ${command.color}`);
        return `${adding ? "Add" : marker ? "Update" : "Set"} marker${name ? ` "${name}"` : ""}${adding && command.frame !== undefined ? ` at ${time(command.frame)}` : ""}${parts.length ? `: ${parts.join("; ")}` : ""}`;
      }
      case "removeMarker": {
        const marker = timeline?.markers.find(
          (marker) => marker.id === command.id,
        );
        return pending
          ? `Remove marker${marker?.name ? ` "${marker.name}"` : ""}`
          : "Removed marker";
      }
      case "setRange":
        return pending
          ? [
              command.in !== undefined &&
                (command.in === null
                  ? "Clear In"
                  : `Set In to ${time(command.in)}`),
              command.out !== undefined &&
                (command.out === null
                  ? "Clear Out"
                  : `Set Out to ${time(command.out)}`),
            ]
              .filter(Boolean)
              .join("; ") || "Change In/Out"
          : "Changed in/out range";
    }
  });
  const label = [...new Set(labels)].filter(Boolean).join("; ");
  return (pending ? label : label.slice(0, 120)) || fallback;
}
