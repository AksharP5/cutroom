import { useState } from "react";
import { MAX_AUDIO_GAIN } from "@hyperframes/core/audio-gain";
import type {
  Clip,
  CommandInput,
  Timeline,
} from "../../../shared/timeline/schema";
import { SelectMenu } from "../../components/SelectMenu";
import { editTimeline } from "../timeline";
import { FieldRow, ValueField } from "./ValueField";

type Route = Extract<CommandInput, { type: "routeAudioGroup" }>["group"];

export function AudioGroupRouting({
  projectId,
  clips,
  timeline,
  disabled,
}: {
  projectId: string;
  clips: readonly Clip[];
  timeline: Timeline;
  disabled?: boolean;
}) {
  const [name, setName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const firstClip = clips[0];
  const first = firstClip?.authoredAudioGroupId;
  const mixed = clips.some(
    ({ authoredAudioGroupId }) => authoredAudioGroupId !== first,
  );
  const groups = timeline.authoredAudioGroups ?? [];
  const group = mixed ? undefined : groups.find(({ id }) => id === first);
  const value = mixed ? "mixed" : first ? `group:${first}` : "track";
  const options = groups.flatMap((group) =>
    !group.sourceRestriction || group.id === first
      ? [{ value: `group:${group.id}`, label: group.label ?? group.id }]
      : [],
  );
  if (!mixed && first && !options.some((option) => option.value === value))
    options.unshift({ value, label: first });
  const route = async (group: Route) => {
    setSaving(true);
    try {
      const saved = await editTimeline(projectId, "Route audio", () => [
        { type: "routeAudioGroup", clipIds: clips.map(({ id }) => id), group },
      ]);
      if (saved) setName(null);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <FieldRow label="Group">
        <SelectMenu
          label="Audio group"
          value={value}
          options={[
            ...(mixed ? [{ value: "mixed", label: "Mixed" }] : []),
            { value: "track", label: "Track mixing" },
            ...options,
            { value: "new", label: "New group…" },
          ]}
          disabled={disabled}
          readOnly={saving}
          onChange={(next) => {
            if (next === "new") setName("");
            else if (next !== value && next !== "mixed")
              void route(next === "track" ? null : next.slice("group:".length));
          }}
        />
      </FieldRow>
      {name !== null && (
        <form
          className="inspector-audio-group-form"
          aria-label="New audio group"
          onSubmit={(event) => {
            event.preventDefault();
            if (!disabled && !saving && name.trim())
              void route({
                id: `bus-${crypto.randomUUID()}`,
                label: name.trim(),
              });
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !saving) {
              event.stopPropagation();
              setName(null);
            }
          }}
        >
          <FieldRow label="Name">
            <input
              aria-label="Audio group name"
              type="text"
              value={name}
              maxLength={120}
              autoFocus
              disabled={disabled || saving}
              onChange={(event) => setName(event.target.value)}
            />
          </FieldRow>
          <div>
            <button
              disabled={saving}
              type="button"
              onClick={() => setName(null)}
            >
              Cancel
            </button>
            <button disabled={disabled || saving || !name.trim()} type="submit">
              Create
            </button>
          </div>
        </form>
      )}
      {firstClip && group && (
        <ValueField
          key={group.id}
          label="Group gain"
          value={group.volume}
          initial={1}
          unit="gain"
          max={MAX_AUDIO_GAIN}
          fps={timeline.fps}
          disabled={
            !!group.sourceRestriction ||
            timeline.clips.some(
              (member) =>
                member.authoredAudioGroupId === group.id &&
                timeline.tracks.some(
                  (track) => track.index === member.track && track.locked,
                ),
            )
          }
          tip={
            group.sourceRestriction ??
            "Changes every member of this authored audio group"
          }
          onCommit={(volume) => {
            if (volume !== null)
              void editTimeline(projectId, "Edit audio group gain", () => [
                { type: "setAudioGroup", clipId: firstClip.id, volume },
              ]);
          }}
        />
      )}
    </>
  );
}
