import { toFrames } from "../../shared/timeline/apply";
import type { Command, Timeline } from "../../shared/timeline/schema";
import { formatTimecode } from "./timecode";
import { formatField } from "./inspector/fields";

/** Name the commands once, when an edit is made, for both history and the inspector. */
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
          const up = command.trackBy > 0 !== (clip?.kind === "audio");
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
      case "insert":
        return `Added ${command.clip.kind} at ${time(command.at)}`;
      case "setClip": {
        const parts: string[] = [];
        if (command.opacity !== undefined)
          parts.push(
            `Set opacity to ${formatField(command.opacity, "percent", timeline.fps)}`,
          );
        if (command.label !== undefined)
          parts.push(
            command.label === null
              ? "Cleared clip name"
              : `Renamed to ${command.label}`,
          );
        if (command.volume !== undefined)
          parts.push(
            `Set volume to ${formatField(command.volume, "percent", timeline.fps)}`,
          );
        if (command.enabled !== undefined)
          parts.push(command.enabled ? "Enabled clip" : "Disabled clip");
        return parts.join("; ");
      }
      case "setTiming": {
        const parts: string[] = [];
        if (command.playbackRate !== undefined)
          parts.push(
            `Set speed to ${formatField(command.playbackRate, "percent", timeline.fps)}`,
          );
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
      case "setMarker":
        return `Set marker at ${time(command.frame)}`;
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
