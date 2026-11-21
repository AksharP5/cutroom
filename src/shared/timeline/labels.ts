import { activeVersion } from "./versions";
import { audioGainToDb } from "@hyperframes/core/audio-gain";
import { localMediaPath } from "../media";
import { gapAt, toFrames } from "./apply";
import { firstTextLine, isAudioKind } from "./schema";
import type { Clip, Command, Timeline } from "./schema";
import { formatTimecode } from "./timecode";
import { TRANSITION_NAMES } from "./transition";
import { ElementStyleSchema, styleDeclarations } from "./elementStyle";
import type { StyleField } from "./elementStyle";

/** How a summary names each style field, in the inspector's words. */
const STYLE_NAMES = new Map<string, string>(
  Object.entries({
    fontFamily: "font",
    fontSize: "font size",
    fontWeight: "font weight",
    letterSpacing: "tracking",
    lineHeight: "leading",
    color: "text colour",
    textAlign: "text alignment",
    textTransform: "case",
    fill: "fill",
    borderRadius: "corner radius",
    shadow: "shadow",
    blur: "blur",
    width: "width",
    height: "height",
    objectFit: "fit",
  } satisfies Record<StyleField, string>),
);

/** What the editor calls each region effect. */
export const REGION_NAMES = {
  zoom: "Zoom",
  blur: "Blur",
  highlight: "Highlight",
} as const;

const decibelText = (volume: number) => {
  const db = audioGainToDb(volume);
  return volume === 0 ? "-inf dB" : `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
};

const sourceName = (src: string) =>
  (localMediaPath("index.html", src) ?? src).split("/").at(-1);

/**
 * A clip's name as the timeline shows it. A title without a label goes by its first line, and an
 * adjustment layer by its effect.
 */
export function clipName(
  clip: Pick<Clip, "id" | "label" | "src" | "title" | "textPreview"> &
    Partial<Pick<Clip, "region" | "adjustment">>,
) {
  const { label, src } = clip;
  if (label !== null) return label;
  if (src !== null) return sourceName(src) ?? clip.id;
  return (
    (clip.title && clip.textPreview) ||
    (clip.adjustment && clip.region && REGION_NAMES[clip.region.effect]) ||
    clip.id
  );
}

/** Percentages keep every digit the engine stores (six decimals of the fraction). */
export const formatPercent = (value: number) =>
  `${Number((value * 100).toFixed(4))}%`;

export const EDIT_LABEL_LIMIT = 120;

const truncate = (text: string, length: number) =>
  Array.from(text).slice(0, length).join("");

/** Deduplicates command sentences and caps saved labels without splitting a code point. */
export function joinEditLabels(labels: string[], fallback: string) {
  return (
    truncate(
      [...new Set(labels)].filter(Boolean).join("; "),
      EDIT_LABEL_LIMIT,
    ) || fallback
  );
}

/**
 * Command sentences shared by history, the inspector, review and agent approvals. `past` reads
 * beside the clip it changed, `done` names the clip so it reads anywhere, `pending` asks.
 */
export function editLabel(
  commands: Command[],
  timeline: Timeline | undefined,
  fallback: string,
  tense: "past" | "done" | "pending" = "past",
): string {
  const pending = tense === "pending";
  const named = tense !== "past";
  const time = (frame: number) =>
    timeline ? formatTimecode(frame, timeline.fps) : `frame ${frame}`;
  const clips = timeline?.clips ?? [];
  const target = (ids: readonly string[]) => {
    if (!ids.length) return "auto-selected clips";
    const names = ids.map((id) => {
      const clip = clips.find((clip) => clip.id === id);
      return clip
        ? (clip.label ??
            (clip.src === null ? undefined : sourceName(clip.src)) ??
            ((clip.title && clip.textPreview) ||
              `a ${clip.kind === "element" ? "text" : clip.kind} clip`))
        : "a clip";
    });
    return names.length > 2
      ? `${names[0]} and ${names.length - 1} more clips`
      : names.join(" and ");
  };
  /** A length as people say it: whole tenths of a second, or frames. */
  const span = (frames: number) => {
    const seconds = timeline
      ? (frames * timeline.fps.den) / timeline.fps.num
      : 0;
    return seconds >= 1 && Number.isInteger(Number((seconds * 10).toFixed(6)))
      ? `${Number(seconds.toFixed(1))} s`
      : `${frames} ${frames === 1 ? "frame" : "frames"}`;
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
            `${Math.abs(command.trackBy)} ${Math.abs(command.trackBy) === 1 ? "track" : "tracks"} ${up ? "up" : "down"}${clip ? ` to ${trackName(clip.track + command.trackBy)}` : ""}`,
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
        return `Moved ${named ? `${target(command.clipIds)} ` : ""}${parts.join(" and ")}`;
      }
      case "trim": {
        const clip = clips.find((clip) => clip.id === command.clipId);
        if (tense === "done" && clip) {
          const grew =
            command.edge === "end"
              ? command.to - clip.start - clip.duration
              : clip.start - command.to;
          return `${grew > 0 ? "Extended" : "Shortened"} ${target([clip.id])} by ${span(Math.abs(grew))}${command.edge === "start" ? " at its start" : ""}${command.ripple ? ", with ripple" : ""}`;
        }
        return pending
          ? `${command.ripple ? "Ripple trim" : "Trim"} ${command.edge} of ${target([command.clipId])} to ${time(command.to)}`
          : `${command.ripple ? "Ripple trimmed" : "Trimmed"} ${command.edge}${named ? ` of ${target([command.clipId])}` : ""} to ${time(command.to)}`;
      }
      case "split":
        return `Split${named ? ` ${target(command.clipIds ?? [])}` : ""} at ${time(command.at)}`;
      case "remove":
        return pending
          ? `${command.ripple ? "Ripple delete" : "Lift"} ${target(command.clipIds)}`
          : `${command.ripple ? "Ripple deleted" : "Lifted"} ${named ? target(command.clipIds) : "clips"}`;
      case "freeze":
        return `${pending ? "Freeze" : "Froze"} ${named ? target([command.clipId]) : "frame"} at ${time(command.at)}`;
      case "closeGap": {
        const gap = timeline && gapAt(timeline, command.track, command.at);
        return `${pending ? "Close" : "Closed"} ${gap ? `the ${span(gap.to - gap.from)} gap` : "the gap"} on ${trackName(command.track)}${gap ? ` at ${time(gap.from)}` : ""}`;
      }
      case "slip":
        return `${pending ? "Slip" : "Slipped"}${named ? ` ${target([command.clipId])}` : ""} ${span(Math.abs(command.by))} ${command.by > 0 ? "later" : "earlier"} in its source${command.linked ? "" : ", without its linked clips"}`;
      case "slide":
        return `${pending ? "Slide" : "Slid"}${named ? ` ${target(command.clipIds)}` : ""} ${span(Math.abs(command.by))} ${command.by > 0 ? "right" : "left"} between ${command.clipIds.length > 1 ? "their" : "its"} neighbours`;
      case "link":
        return `${pending ? "Link" : "Linked"} ${target(command.clipIds)}`;
      case "unlink":
        return `${pending ? "Unlink" : "Unlinked"} ${target(command.clipIds)}`;
      case "paste":
        return `${pending ? "Paste" : "Pasted"} clips${pending || command.mode === "insert" ? ` with ${command.mode}` : ""} at ${time(command.at)}`;
      case "insert": {
        const name =
          command.clip.kind === "title"
            ? `title "${firstTextLine(command.clip.text)}"`
            : command.clip.kind === "adjustment"
              ? (command.clip.label ??
                `${REGION_NAMES[command.clip.region.effect].toLowerCase()} layer`)
              : (command.clip.label ??
                sourceName(command.clip.src) ??
                command.clip.kind);
        if (pending && command.mode === "overwrite") {
          const tracks = [trackName(command.track)];
          if (command.linkedAudio?.track !== undefined)
            tracks.push(trackName(command.linkedAudio.track));
          return `Overwrite ${tracks.join(" and ")} from ${time(command.at)} to ${time(command.at + command.clip.duration)} with ${name}`;
        }
        return pending
          ? `Add ${name} at ${time(command.at)}${command.mode !== "place" ? ` with ${command.mode}` : ""}`
          : `Added ${named ? name : command.clip.kind} at ${time(command.at)}`;
      }
      case "setClip": {
        const parts: string[] = [];
        const reset =
          command.x === null &&
          command.y === null &&
          command.scale === null &&
          command.rotation === null &&
          command.crop === null;
        if (reset) parts.push("Reset transform");
        else if (command.x === null && command.y === null)
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
        const scale = [
          command.scaleX ?? command.scale,
          command.scaleY ?? command.scale,
        ];
        if (
          !reset &&
          (command.scale !== undefined ||
            command.scaleX !== undefined ||
            command.scaleY !== undefined)
        )
          parts.push(
            scale.every((value) => value === null || value === 1)
              ? "Reset scale"
              : command.scale !== undefined && scale[0] === scale[1]
                ? `Set scale to ${formatPercent(command.scale ?? 1)}`
                : (["X", "Y"] as const)
                    .flatMap((axis, index) =>
                      scale[index] === undefined
                        ? []
                        : [
                            `Set scale ${axis} to ${formatPercent(scale[index] ?? 1)}`,
                          ],
                    )
                    .join("; "),
          );
        if (!reset && command.rotation !== undefined)
          parts.push(
            command.rotation
              ? `Set rotation to ${command.rotation}°`
              : "Reset rotation",
          );
        if (!reset && command.crop !== undefined)
          parts.push(
            command.crop === null
              ? "Reset crop"
              : `Set crop ${(["left", "right", "top", "bottom"] as const)
                  .flatMap((edge) =>
                    command.crop?.[edge] === undefined
                      ? []
                      : [`${edge} to ${command.crop[edge]} px`],
                  )
                  .join(", ")}`,
          );
        if (command.text !== undefined) {
          const words = command.text.replaceAll("\n", " ");
          parts.push(
            `Set text to “${words.length > 40 ? `${truncate(words, 40).trimEnd()}…` : words}”`,
          );
        }
        if (command.title !== undefined) {
          const { in: entrance, out: exit, ...look } = command.title;
          const names = {
            position: "position",
            font: "font",
            size: "size",
            weight: "weight",
            color: "colour",
            align: "alignment",
            plate: "plate",
          } as const;
          for (const [field, name] of Object.entries(names) as [
            keyof typeof names,
            string,
          ][]) {
            const value = look[field];
            if (value === undefined) continue;
            parts.push(
              value === null
                ? field === "plate"
                  ? `${pending ? "Remove" : "Removed"} title plate`
                  : "Set title font to the composition's font"
                : `Set title ${name} to ${value}${field === "size" ? " px" : ""}`,
            );
          }
          const { shadow, stroke } = look;
          if (shadow !== undefined)
            parts.push(
              shadow === null
                ? `${pending ? "Remove" : "Removed"} title shadow`
                : `Set title shadow to ${shadow.color}, ${shadow.blur} px blur`,
            );
          if (stroke !== undefined)
            parts.push(
              stroke === null
                ? `${pending ? "Remove" : "Removed"} title stroke`
                : `Set title stroke to ${stroke.color}, ${stroke.width} px`,
            );
          for (const [name, motion] of [
            ["entrance", entrance],
            ["exit", exit],
          ] as const) {
            if (!motion) continue;
            const length =
              motion.frames === undefined ? [] : [time(motion.frames)];
            parts.push(
              `Set title ${name} to ${[...(motion.preset ? [motion.preset] : []), ...length].join(", ")}`,
            );
          }
        }
        if (command.style !== undefined) {
          const fields = Object.entries(command.style);
          if (fields.length > 3)
            parts.push(
              fields.every(([, value]) => value === null)
                ? "Reset style"
                : `Set ${fields.length} style properties`,
            );
          else
            for (const [field, value] of fields) {
              const name = STYLE_NAMES.get(field);
              const written =
                value !== null &&
                Object.values(
                  styleDeclarations(
                    ElementStyleSchema.parse({ [field]: value }),
                  ),
                ).find((declaration) => declaration !== null);
              parts.push(
                written ? `Set ${name} to ${written}` : `Reset ${name}`,
              );
            }
        }
        if (command.grade === null)
          parts.push(`${pending ? "Remove" : "Removed"} grade`);
        else if (command.grade) {
          const { adjust, lut, intensity, ...stages } = command.grade;
          const grade = [
            ...Object.entries(adjust ?? {}).map(([control, value]) =>
              value ? `Set ${control} to ${value}` : `Reset ${control}`,
            ),
            ...Object.entries({
              wheels: "colour wheels",
              curves: "curves",
              hueCurves: "hue curves",
              secondaries: "secondaries",
            } as const).flatMap(([stage, name]) =>
              stages[stage as keyof typeof stages] === undefined
                ? []
                : [`Set ${name}`],
            ),
            ...(lut === undefined
              ? []
              : [
                  lut === null
                    ? `${pending ? "Remove" : "Removed"} look LUT`
                    : `Set look LUT to ${lut.src.split("/").at(-1)}`,
                ]),
            ...(intensity === undefined
              ? []
              : [`Set grade intensity to ${formatPercent(intensity)}`]),
          ];
          parts.push(
            ...(grade.length > 3
              ? [`Set ${grade.length} grade controls`]
              : grade),
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
          parts.push(
            command.automation === null
              ? "Clear audio automation"
              : "Edit volume automation",
          );
        return `${parts.join("; ") || (pending ? fallback : "")}${named && (pending || parts.length) ? ` for ${target([command.clipId])}` : ""}`;
      }
      case "setKeyframe":
      case "removeKeyframe":
      case "moveKeyframe": {
        const clip = clips.find((clip) => clip.id === command.clipId);
        const at = (frame: number) => time((clip?.start ?? 0) + frame);
        const existing = clip?.keyframes?.[command.property]?.some(
          (keyframe) => keyframe.frame === command.frame,
        );
        const what = `${command.property} keyframe`;
        const sentence =
          command.type === "removeKeyframe"
            ? `${pending ? "Remove" : "Removed"} the ${what} at ${at(command.frame)}`
            : command.type === "moveKeyframe"
              ? `${pending ? "Move" : "Moved"} the ${what} to ${at(command.to)}`
              : existing
                ? `${pending ? "Change" : "Changed"} the ${what} at ${at(command.frame)}`
                : `${pending ? "Add" : "Added"} ${command.property === "opacity" ? "an" : "a"} ${what} at ${at(command.frame)}`;
        return `${sentence}${named ? ` on ${target([command.clipId])}` : ""}`;
      }
      case "setTransitions":
        return `${pending ? "Add" : "Added"} ${command.cuts.length} transitions`;
      case "setTransition": {
        const cut = named
          ? ` between ${target([command.from, command.to])}`
          : "";
        const { transition } = command;
        if (!transition)
          return `${pending ? "Remove" : "Removed"} the transition${cut}`;
        const existing = clips.find(
          (clip) => clip.id === command.to,
        )?.transitionIn;
        const what = `${span(transition.duration)} ${TRANSITION_NAMES[transition.kind].toLowerCase()}`;
        return existing
          ? `${pending ? "Change" : "Changed"} the transition${cut} to ${what}`
          : `${pending ? "Add" : "Added"} ${what}${cut}`;
      }
      case "setTiming": {
        const parts: string[] = [];
        if (command.playbackRate !== undefined)
          parts.push(`Set speed to ${formatPercent(command.playbackRate)}`);
        if (command.mediaStart !== undefined)
          parts.push(
            `Set source in to ${timeline ? time(toFrames(command.mediaStart, timeline.fps)) : `${command.mediaStart}s`}`,
          );
        return `${parts.join("; ") || (pending ? fallback : "")}${named && (pending || parts.length) ? ` for ${target([command.clipId])}` : ""}`;
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
        if (command.volume !== undefined) {
          const db = audioGainToDb(command.volume);
          parts.push(
            `Set ${trackName(command.index)} gain to ${command.volume === 0 ? "-inf" : `${db > 0 ? "+" : ""}${Number(db.toFixed(1))}`} dB`,
          );
        }
        if (creating)
          return [
            `Add ${command.kind ?? "video"} track ${command.index}`,
            ...parts,
          ].join("; ");
        return (
          (parts.join("; ") || fallback) +
          (named && command.volume === undefined && trackName(command.index)
            ? ` ${trackName(command.index)}`
            : "")
        );
      }
      case "routeAudioGroup": {
        const { group } = command;
        const name =
          typeof group === "string"
            ? (timeline?.authoredAudioGroups?.find(({ id }) => id === group)
                ?.label ?? group)
            : group?.label;
        return name ? `Route audio to ${name}` : "Return audio to track mixing";
      }
      case "setAudioGroup":
      case "removeAudioGroup": {
        const group = timeline?.authoredAudioGroups?.find(({ id }) =>
          command.type === "removeAudioGroup" || command.group !== undefined
            ? id === command.group
            : id ===
              timeline.clips.find((clip) => clip.id === command.clipId)
                ?.authoredAudioGroupId,
        );
        const name = group ? (group.label ?? group.id) : "bus";
        if (command.type === "removeAudioGroup")
          return `${pending ? "Delete" : "Deleted"} ${name}`;
        const change =
          command.label !== undefined
            ? `${pending ? "Rename" : "Renamed"} ${name} to ${command.label}`
            : command.volume !== undefined
              ? `Set ${name} gain to ${decibelText(command.volume)}`
              : command.muted !== undefined
                ? `${command.muted ? (pending ? "Mute" : "Muted") : pending ? "Unmute" : "Unmuted"} ${name}`
                : command.solo !== undefined
                  ? `${command.solo ? (pending ? "Solo" : "Soloed") : pending ? "Unsolo" : "Unsoloed"} ${name}`
                  : command.fx !== undefined
                    ? `${pending ? "Change" : "Changed"} ${name} effects`
                    : `${pending ? "Clear" : "Cleared"} ${name} automation`;
        return change;
      }
      case "setMaster":
        return command.volume !== undefined && command.fx === undefined
          ? `Set Main gain to ${decibelText(command.volume)}`
          : `${pending ? "Change" : "Changed"} Main effects`;
      case "removeTrack":
        return pending
          ? `Remove empty ${trackName(command.index)}`
          : `Removed empty ${named ? trackName(command.index) : "track"}`;
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
              ? `note to "${note.length > 80 ? `${truncate(note, 80).trimEnd()}…` : note}"`
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
      case "setVersions":
        return `${pending ? "Give" : "Gave"}${named ? ` ${target([command.clipId])}` : ""} ${command.versions.length} versions, showing "${command.versions[command.active]?.name ?? "the first"}"`;
      case "setVersion":
      case "keepVersion": {
        const clip = clips.find((clip) => clip.id === command.clipId);
        const index = command.version ?? (clip && activeVersion(clip));
        const name =
          index === undefined ? undefined : clip?.versions?.[index]?.name;
        const version = name === undefined ? "a version" : `version "${name}"`;
        if (command.type === "setVersion")
          return `${pending ? "Show" : "Showed"} ${version}${named ? ` of ${target([command.clipId])}` : ""}`;
        return `${pending ? "Keep" : "Kept"} ${version}${named ? ` of ${target([command.clipId])}` : ""} and ${pending ? "drop" : "dropped"} the others`;
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
  return pending
    ? [...new Set(labels)].filter(Boolean).join("; ") || fallback
    : joinEditLabels(labels, fallback);
}
