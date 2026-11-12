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

/** Name the commands once, when an edit is made, for history, the inspector and agent edits. */
export function editLabel(
  commands: Command[],
  timeline: Timeline,
  fallback: string,
): string {
  const time = (frame: number) => formatTimecode(frame, timeline.fps);
  const labels = commands.map((command) => {
    switch (command.type) {
      case "move": {
        const parts: string[] = [];
        if (command.by)
          parts.push(
            `${Math.abs(command.by)} ${Math.abs(command.by) === 1 ? "frame" : "frames"} ${command.by > 0 ? "right" : "left"}`,
          );
        if (command.trackBy) {
          const clip = timeline.clips.find(
            (item) => item.id === (command.trackClipIds ?? command.clipIds)[0],
          );
          const up =
            command.trackBy > 0 !==
            (clip !== undefined && isAudioKind(clip.kind));
          parts.push(
            `${Math.abs(command.trackBy)} ${Math.abs(command.trackBy) === 1 ? "track" : "tracks"} ${up ? "up" : "down"}`,
          );
        }
        return `Moved ${parts.join(" and ")}`;
      }
      case "trim":
        return `${command.ripple ? "Ripple trimmed" : "Trimmed"} ${command.edge} to ${time(command.to)}`;
      case "split":
        return `Split at ${time(command.at)}`;
      case "remove":
        return command.ripple ? "Ripple deleted clips" : "Lifted clips";
      case "paste":
        return `Pasted clips${command.mode === "insert" ? " with insert" : ""} at ${time(command.at)}`;
      case "insert":
        return `Added ${command.clip.kind} at ${time(command.at)}`;
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
              timeline.clips.find((clip) => clip.id === command.clipId)?.[
                axis
              ] ?? 0;
            const delta = Number((value - before).toFixed(6));
            if (delta)
              parts.push(
                `Moved ${Math.abs(delta)} px ${axis === "x" ? (delta > 0 ? "right" : "left") : delta > 0 ? "down" : "up"}`,
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
              ? "Cleared clip name"
              : `Renamed to ${command.label}`,
          );
        if (command.volume !== undefined) {
          const db = audioGainToDb(command.volume ?? 1);
          parts.push(
            command.volume === 0
              ? "Silenced clip"
              : `Set gain to ${db > 0 ? "+" : ""}${db.toFixed(1)} dB`,
          );
        }
        if (command.fadeIn !== undefined)
          parts.push(`Set fade in to ${time(command.fadeIn)}`);
        if (command.fadeOut !== undefined)
          parts.push(`Set fade out to ${time(command.fadeOut)}`);
        if (command.enabled !== undefined)
          parts.push(command.enabled ? "Enabled clip" : "Disabled clip");
        return parts.join("; ");
      }
      case "setTiming": {
        const parts: string[] = [];
        if (command.playbackRate !== undefined)
          parts.push(`Set speed to ${formatPercent(command.playbackRate)}`);
        if (command.mediaStart !== undefined)
          parts.push(
            `Set source in to ${time(toFrames(command.mediaStart, timeline.fps))}`,
          );
        return parts.join("; ");
      }
      case "setTrack": {
        if (!timeline.tracks.some((track) => track.index === command.index))
          return `Added ${command.kind ?? "video"} track`;
        const parts: string[] = [];
        if (command.name !== undefined)
          parts.push(
            command.name === null
              ? "Cleared track name"
              : `Renamed track to ${command.name}`,
          );
        if (command.locked !== undefined)
          parts.push(command.locked ? "Locked track" : "Unlocked track");
        if (command.enabled !== undefined)
          parts.push(command.enabled ? "Enabled track" : "Disabled track");
        if (command.autoSelect !== undefined)
          parts.push(
            command.autoSelect
              ? "Enabled track auto-select"
              : "Disabled track auto-select",
          );
        if (command.muted !== undefined)
          parts.push(command.muted ? "Muted track" : "Unmuted track");
        if (command.solo !== undefined)
          parts.push(command.solo ? "Soloed track" : "Unsoloed track");
        return parts.join("; ") || fallback;
      }
      case "removeTrack":
        return "Removed empty track";
      case "setMarker":
        return command.frame === undefined
          ? "Edited marker"
          : `Set marker at ${time(command.frame)}`;
      case "removeMarker":
        return "Removed marker";
      case "setRange":
        return "Changed in/out range";
    }
  });
  return (
    [...new Set(labels)].filter(Boolean).join("; ").slice(0, 120) || fallback
  );
}
