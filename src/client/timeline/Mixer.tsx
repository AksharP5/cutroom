import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  ReactNode,
  RefObject,
} from "react";
import { Faders } from "@phosphor-icons/react";
import { getAudioFxDef } from "@hyperframes/core/audio-fx";
import {
  MAX_AUDIO_GAIN,
  audioDbToGain,
  audioGainToDb,
} from "@hyperframes/core/audio-gain";
import { MIN_MAIN_VOLUME } from "../../shared/timeline/schema";
import type {
  AudioGroup,
  CommandInput,
  Timeline,
  Track,
} from "../../shared/timeline/schema";
import type { FxInput, FxNode } from "../../shared/timeline/fx";
import { mixSilences, trackMix } from "../../shared/timeline/tracks";
import { openContextMenu } from "../components/ContextMenu";
import type { MenuItem } from "../components/menu";
import { SILENCE_DB, parseGain } from "../edit/inspector/fields";
import { FxRack } from "../edit/inspector/FxRack";
import { audioLevels } from "../edit/levels";
import { previewMix } from "../edit/preview";
import type { MixScope } from "../edit/preview";
import { editTimeline, useTimeline } from "../edit/timeline";
import { openFile } from "../edit/code/code";
import { showToast, useWorkspace } from "../workspace";
import { meterPainter } from "./meters";
import type { Row } from "./math";
import "./mixer.css";

/**
 * Where a gain sits on the fader, from the top: +12 dB at 0, and at 1 -60 dB, which reads as
 * silence everywhere else gain is typed or dragged.
 */
const SCALE = [
  [12, 0],
  [6, 0.14],
  [0, 0.28],
  [-6, 0.42],
  [-12, 0.54],
  [-24, 0.71],
  [-48, 0.9],
  [SILENCE_DB, 1],
] as const;
const TICKS = [12, 6, 0, -6, -12, -24, -48] as const;
const BOTTOM_DB = SCALE.at(-1)![0];

function faderAt(volume: number) {
  if (volume <= 0) return 1;
  const db = audioGainToDb(volume);
  for (let index = 1; index < SCALE.length; index++) {
    const [d0, f0] = SCALE[index - 1]!;
    const [d1, f1] = SCALE[index]!;
    if (db >= d1) return Math.max(0, f0 + ((f1 - f0) * (d0 - db)) / (d0 - d1));
  }
  return 1;
}

function dbAt(fraction: number) {
  if (fraction <= 0) return SCALE[0][0];
  for (let index = 1; index < SCALE.length; index++) {
    const [d0, f0] = SCALE[index - 1]!;
    const [d1, f1] = SCALE[index]!;
    if (fraction <= f1) return d0 + ((d1 - d0) * (fraction - f0)) / (f1 - f0);
  }
  return -Infinity;
}

/** Gain in tenths of a dB, as the value reads; the bottom of the travel is silence. */
const gainOf = (db: number, floor: number) => {
  if (db <= BOTTOM_DB) return floor;
  const rounded = Math.round(Math.min(db, audioGainToDb(MAX_AUDIO_GAIN)) * 10);
  return Math.max(floor, audioDbToGain(rounded / 10));
};

const valueText = (volume: number) => {
  if (volume <= 0) return "-inf";
  const db = Math.round(audioGainToDb(volume) * 10) / 10;
  return db === 0 ? "0.0" : `${db > 0 ? "+" : ""}${db.toFixed(1)}`;
};

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

const fxName = (node: FxNode) =>
  node.label ?? getAudioFxDef(node.type)?.label ?? node.type;

interface StripModel {
  /** The meter and live-gain key: `track:<index>`, `bus:<id>` or `main`. */
  key: string;
  kind: "track" | "bus" | "main";
  name: string;
  code?: string;
  title?: string;
  fx: readonly FxNode[];
  members: ReactNode;
  muted?: boolean;
  solo?: boolean;
  /** Silent because something else is soloed: its meter dims. */
  quiet: boolean;
  volume: number;
  floor: number;
  automated?: boolean;
  /** Why the fader is off, as its title. */
  faderOff?: string;
  /** Why mute, effects and the rest are off. */
  locked?: string;
  onMute?(): void;
  onSolo?(): void;
  onVolume(volume: number): void;
  onFx(label: string, fx: FxInput[]): void;
  onName?(event: MouseEvent<HTMLElement>): void;
  onRename?(name: string): void;
  bus?: AudioGroup;
  /** A bus's member clips, which hovering its strip outlines on the timeline. */
  memberIds?: readonly string[];
}

export interface MixerProps {
  projectId: string;
  /** The composition's file, which Source opens for a bus Cutroom cannot edit. */
  composition: string;
  timeline: Timeline;
  /** Track ids as the headers show them, A1 first. */
  rows: readonly Row[];
  onTrackMenu(event: MouseEvent, anchor: Element, row: Row): void;
  onToggleTrack(track: Track, setting: "muted" | "solo"): void;
  onTrackGain(track: Track, volume: number): void;
  onClose(): void;
}

/**
 * Every audio track and bus side by side with Main, each with a fader and a meter. Faders are
 * heard while they move and save once on release; meters paint from the preview's samples
 * without React.
 */
export function Mixer({
  projectId,
  composition,
  timeline,
  rows,
  onTrackMenu,
  onToggleTrack,
  onTrackGain,
  onClose,
}: MixerProps) {
  const root = useRef<HTMLDivElement>(null);
  const [rack, setRack] = useState<{
    key: string;
    open?: string;
  } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const closeRack = useCallback(() => setRack(null), []);
  useEffect(() => {
    audioLevels.setStripMetering(true);
    return () => audioLevels.setStripMetering(false);
  }, []);
  const selection = useTimeline((state) => state.selection);
  const edit = (label: string, commands: CommandInput[]) =>
    void editTimeline(projectId, label, () => commands);

  const mix = trackMix(timeline);
  const groups = timeline.authoredAudioGroups ?? [];
  const lockedTrack = new Set(
    timeline.tracks.filter((track) => track.locked).map(({ index }) => index),
  );
  const audioRows = rows.filter((row) => row.track.kind === "audio");
  const trackId = new Map(rows.map((row) => [row.track.index, row.id]));

  const tracks = audioRows.map(({ track, id }): StripModel => {
    const sounds = timeline.clips.filter(
      (clip) => clip.track === track.index && clip.hasAudio,
    );
    const buses = [
      ...new Set(sounds.map((clip) => clip.authoredAudioGroupId ?? null)),
    ];
    const routed =
      sounds.length > 0 && buses.every((bus) => bus !== null) ? buses : [];
    const busName = (bus: string | null) => {
      const group = groups.find(({ id }) => id === bus);
      return group?.label ?? group?.id ?? bus ?? "";
    };
    return {
      key: `track:${track.index}`,
      kind: "track",
      name: track.name ?? `Audio ${id.slice(1)}`,
      code: id,
      fx: track.fx,
      members: routed.length
        ? `${busName(routed[0]!)}${routed.length > 1 ? ` +${routed.length - 1}` : ""}`
        : null,
      muted: track.muted,
      solo: track.solo,
      // Silent because of another solo; a clip in a soloed bus still sounds from here.
      quiet:
        !track.muted &&
        (sounds.length
          ? sounds.every((clip) => mixSilences(mix, clip))
          : mix.solo && !track.solo),
      volume: track.volume,
      floor: 0,
      faderOff: routed.length
        ? "Every clip on this track plays through a bus. Set the bus instead."
        : undefined,
      onMute: () => onToggleTrack(track, "muted"),
      onSolo: () => onToggleTrack(track, "solo"),
      onVolume: (volume) => onTrackGain(track, volume),
      onFx: (label, fx) =>
        edit(label, [
          { type: "setTrack", index: track.index, kind: track.kind, fx },
        ]),
      onName: (event) =>
        onTrackMenu(event, event.currentTarget, {
          track,
          id,
          top: 0,
          height: 0,
        }),
    };
  });

  const buses = groups.map((group): StripModel => {
    const members = timeline.clips.filter(
      (clip) => clip.authoredAudioGroupId === group.id,
    );
    const locked = members.find((clip) => lockedTrack.has(clip.track));
    const lockedReason =
      group.sourceRestriction ??
      (locked
        ? `${trackId.get(locked.track) ?? "A track"} is locked`
        : undefined);
    const name = group.label ?? group.id;
    const set = (
      label: string,
      change: Omit<
        Extract<CommandInput, { type: "setAudioGroup" }>,
        "type" | "group" | "clipId"
      >,
    ) => edit(label, [{ type: "setAudioGroup", group: group.id, ...change }]);
    const selectMembers = () =>
      useTimeline.setState({
        selection: {
          ids: new Set(members.map(({ id }) => id)),
          anchor: members[0]?.id ?? null,
        },
      });
    const menu = (event: MouseEvent<HTMLElement>) =>
      openContextMenu(event, name, busMenu(), event.currentTarget);
    const busMenu = (): MenuItem[] => [
      ...(group.sourceRestriction
        ? [
            {
              label: "Source",
              run: async () => {
                if (await openFile(composition))
                  useWorkspace.setState({ code: true });
              },
            },
            "separator" as const,
          ]
        : []),
      {
        label: "Rename",
        disabled: !!lockedReason,
        run: () => setRenaming(group.id),
      },
      {
        label: "Select clips",
        disabled: !members.length,
        run: selectMembers,
      },
      {
        label: "Effects...",
        disabled: !!lockedReason,
        run: () => setRack({ key: `bus:${group.id}` }),
      },
      {
        label: "Clear automation",
        disabled: !group.automated || !!lockedReason,
        run: () => set(`Clear ${name} automation`, { automation: null }),
      },
      "separator",
      {
        label: "Delete bus",
        disabled: !!lockedReason,
        run: () =>
          edit(`Delete ${name}`, [
            { type: "removeAudioGroup", group: group.id },
          ]),
      },
    ];
    return {
      key: `bus:${group.id}`,
      kind: "bus",
      name,
      title: group.sourceRestriction,
      bus: group,
      memberIds: members.map(({ id }) => id),
      fx: group.fx,
      members: members.length ? (
        <button type="button" title="Select clips" onClick={selectMembers}>
          {plural(members.length, "clip")}
        </button>
      ) : (
        plural(0, "clip")
      ),
      muted: group.muted,
      solo: group.solo,
      quiet:
        mix.solo &&
        !group.solo &&
        !group.muted &&
        !members.some((clip) => clip.enabled && !mixSilences(mix, clip)),
      volume: group.volume,
      floor: 0,
      automated: group.automated,
      faderOff: group.automated
        ? "Bus gain is automated. Clear automation to set it by hand."
        : lockedReason,
      locked: lockedReason,
      onMute: () =>
        set(`${group.muted ? "Unmute" : "Mute"} ${name}`, {
          muted: !group.muted,
        }),
      onSolo: () =>
        set(`${group.solo ? "Unsolo" : "Solo"} ${name}`, {
          solo: !group.solo,
        }),
      onVolume: (volume) => set(`${name} gain`, { volume }),
      onFx: (label, fx) => set(label, { fx }),
      onName: menu,
      onRename: (label) => {
        if (label && label !== group.label) set(`Rename ${name}`, { label });
      },
    };
  });

  const main = timeline.main ?? { volume: 1, fx: [] };
  const master: StripModel = {
    key: "main",
    kind: "main",
    name: "Main",
    fx: main.fx,
    members: null,
    quiet: false,
    volume: main.volume,
    floor: MIN_MAIN_VOLUME,
    faderOff: timeline.main?.sourceRestriction,
    onVolume: (volume) => edit(`Main gain`, [{ type: "setMaster", volume }]),
    onFx: (label, fx) => edit(label, [{ type: "setMaster", fx }]),
  };

  const strips = [...tracks, ...buses, master];
  useMeters(root, strips);

  const usable = timeline.clips.filter(
    (clip) =>
      selection.ids.has(clip.id) &&
      clip.hasAudio &&
      !lockedTrack.has(clip.track),
  );
  const newBus = () => {
    const taken = new Set(groups.map(({ label, id }) => label ?? id));
    let number = 1;
    while (taken.has(`Bus ${number}`)) number++;
    void editTimeline(projectId, `New bus`, () => [
      {
        type: "routeAudioGroup",
        clipIds: usable.map(({ id }) => id),
        group: { label: `Bus ${number}` },
      },
    ]).then((saved) => {
      if (!saved) return;
      const created = useTimeline
        .getState()
        .view?.timeline.authoredAudioGroups?.find(
          ({ label }) => label === `Bus ${number}`,
        );
      if (created) setRenaming(created.id);
    });
  };

  const open = rack && strips.find(({ key }) => key === rack.key);
  const scope = { projectId, composition };
  const strip = (model: StripModel) => (
    <Strip
      key={model.key}
      model={model}
      scope={scope}
      renaming={model.bus !== undefined && renaming === model.bus.id}
      onRenaming={(active) => setRenaming(active ? model.bus!.id : null)}
      onRack={(open) => setRack({ key: model.key, open })}
      onClose={model.kind === "main" ? onClose : undefined}
      rootRef={root}
    />
  );
  return (
    <div className="mixer" role="region" aria-label="Mixer" ref={root}>
      <div className="mixer-scroll">
        {tracks.map(strip)}
        {buses.length > 0 && <i className="mixer-seam" />}
        {buses.map(strip)}
        <i className="mixer-seam" />
        <div className="mixer-new">
          <button
            type="button"
            className="text-button"
            disabled={!usable.length}
            onClick={newBus}
          >
            New bus
          </button>
          {!usable.length && <p>Select clips with sound</p>}
        </div>
      </div>
      {strip(master)}
      {open && (
        <Rack
          key={open.key}
          anchor={root.current?.querySelector(
            `[data-strip="${CSS.escape(open.key)}"]`,
          )}
          name={open.name}
          fx={open.fx}
          open={rack.open}
          disabled={!!open.locked}
          onChange={open.onFx}
          onClose={closeRack}
        />
      )}
    </div>
  );
}

/** Members of a bus get the hover outline on the timeline; nothing is stored. */
function outline(root: HTMLElement | null, ids: readonly string[]) {
  const lanes = root?.closest(".tl")?.querySelector(".tl-lanes");
  if (!lanes) return;
  for (const element of lanes.querySelectorAll("[data-bus-member]"))
    element.removeAttribute("data-bus-member");
  for (const id of ids)
    lanes
      .querySelector(`[data-clip-mix="${CSS.escape(id)}"]`)
      ?.setAttribute("data-bus-member", "");
}

function Strip({
  model,
  scope,
  renaming,
  onRenaming,
  onRack,
  onClose,
  rootRef,
}: {
  model: StripModel;
  scope: MixScope;
  renaming: boolean;
  onRenaming(active: boolean): void;
  onRack(open?: string): void;
  onClose?(): void;
  rootRef: RefObject<HTMLDivElement | null>;
}) {
  const shown = model.fx.slice(0, model.fx.length > 3 ? 2 : 3);
  const more = model.fx.length - shown.length;
  return (
    <div
      className={`mixer-strip${model.kind === "main" ? " main" : ""}`}
      role="group"
      aria-label={model.code ? `${model.code} ${model.name}` : model.name}
      data-strip={model.key}
      data-bus-drop={model.bus && !model.locked ? model.bus.id : undefined}
      data-muted={model.muted ? "" : undefined}
      data-quiet={model.quiet ? "" : undefined}
      onPointerEnter={() => {
        if (model.memberIds) outline(rootRef.current, model.memberIds);
      }}
      onPointerLeave={() => {
        if (model.bus) outline(rootRef.current, []);
      }}
    >
      {renaming && model.onRename ? (
        <input
          className="mixer-name mixer-rename"
          aria-label="Bus name"
          defaultValue={model.name}
          maxLength={120}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onBlur={(event) => {
            model.onRename?.(event.currentTarget.value.trim());
            onRenaming(false);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
              event.currentTarget.value = model.name;
              event.currentTarget.blur();
            }
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      ) : (
        <div
          className="mixer-name"
          title={model.title ?? model.name}
          onContextMenu={model.onName}
          onDoubleClick={() => {
            if (model.onRename && !model.locked) onRenaming(true);
          }}
        >
          {model.code && <b>{model.code}</b>}
          <span>{model.name}</span>
          {onClose && (
            <button
              type="button"
              className="icon-button mixer-toggle"
              aria-label="Mixer"
              aria-pressed="true"
              title="Mixer"
              onClick={onClose}
            >
              <Faders size={16} />
            </button>
          )}
        </div>
      )}
      <div className="mixer-fx">
        {shown.map((node) => (
          <button
            key={node.id}
            type="button"
            title={fxName(node)}
            data-bypassed={node.enabled ? undefined : ""}
            disabled={!!model.locked}
            onClick={() => onRack(node.id)}
          >
            {fxName(node)}
          </button>
        ))}
        {more > 0 && (
          <button
            type="button"
            className="quiet"
            disabled={!!model.locked}
            onClick={() => onRack()}
          >
            +{more} more
          </button>
        )}
        {!model.fx.length && !model.locked && (
          <button
            type="button"
            className="quiet mixer-add"
            onClick={() => onRack("add")}
          >
            Add effect
          </button>
        )}
      </div>
      <div className="mixer-members">{model.members}</div>
      <div className="mixer-switches">
        {model.onMute && (
          <button
            type="button"
            className={`tl-track-button${model.muted ? " exception" : ""}`}
            aria-pressed={!!model.muted}
            aria-label={`Mute ${model.code ?? model.name}`}
            title={model.locked ?? "Mute"}
            disabled={!!model.locked}
            onClick={model.onMute}
          >
            M
          </button>
        )}
        {model.onSolo && (
          <button
            type="button"
            className={`tl-track-button${model.solo ? " exception" : ""}`}
            aria-pressed={!!model.solo}
            aria-label={`Solo ${model.code ?? model.name}`}
            title={model.locked ?? "Solo (also in export)"}
            disabled={!!model.locked}
            onClick={model.onSolo}
          >
            S
          </button>
        )}
      </div>
      <Fader model={model} scope={scope} />
    </div>
  );
}

/**
 * The fader, its scale, the strip's meter and its value. A drag moves the cap and the value in
 * the same frame, transform only, and sets the gain the preview plays on every pointer event.
 */
function Fader({ model, scope }: { model: StripModel; scope: MixScope }) {
  const travel = useRef<HTMLDivElement>(null);
  const cap = useRef<HTMLDivElement>(null);
  const value = useRef<HTMLSpanElement>(null);
  const [typing, setTyping] = useState(false);
  const drag = useRef<{
    y: number;
    from: number;
    next: number;
    fine: boolean;
    moved: boolean;
    height: number;
    release(): void;
  } | null>(null);
  const keys = useRef<{ next: number; timer: number } | null>(null);
  const off = model.faderOff;
  const { volume, floor } = model;

  const shownVolume = useRef(volume);
  shownVolume.current = volume;
  /** The level this strip last sent the preview, or null while it plays the saved one. */
  const sent = useRef<number | null>(null);
  const send = (level: number) => {
    sent.current = level;
    previewMix(scope, model.key, level);
  };
  // A saved, undone or refused gain lands where the props put the cap, with no easing, and the
  // preview plays it whatever was sent before.
  useLayoutEffect(() => {
    if (cap.current) cap.current.style.transform = "";
    if (value.current) value.current.textContent = valueText(volume);
    if (sent.current !== null && sent.current !== volume) send(volume);
  }, [volume, model.key]);

  /** The level the preview plays while the fader moves, before anything is saved. */
  const draft = (next: number) => {
    if (cap.current && travel.current) {
      const height = travel.current.clientHeight;
      cap.current.style.transform = `translateY(${(faderAt(next) - faderAt(volume)) * height}px)`;
    }
    if (value.current) value.current.textContent = valueText(next);
    send(next);
  };
  const reset = () => draft(volume);
  const commit = (next: number) => {
    const open = useTimeline.getState();
    if (
      next === volume ||
      scope.projectId !== open.projectId ||
      scope.composition !== open.composition
    )
      return reset();
    model.onVolume(next);
    // The editor shows an edit it takes at once; one it refused leaves the saved gain. A refusal
    // from the server later changes the props, which sends the saved gain again.
    requestAnimationFrame(() => {
      if (shownVolume.current !== next) reset();
    });
  };

  const end = () => {
    const held = drag.current;
    drag.current = null;
    held?.release();
    return held;
  };
  useEffect(
    () => () => {
      end();
      window.clearTimeout(keys.current?.timer);
      keys.current = null;
      if (sent.current !== null && sent.current !== shownVolume.current)
        previewMix(scope, model.key, shownVolume.current);
    },
    [],
  );
  useAutomatedFader(model, cap, value, travel);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || off || !travel.current) return;
    // The clip marks sit over the travel and take their own clicks.
    if (event.target instanceof Element && event.target.closest(".mixer-clip"))
      return;
    event.preventDefault();
    cap.current?.focus();
    if (event.altKey) {
      commit(1);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const box = travel.current.getBoundingClientRect();
    const onCap = event.target === cap.current;
    const from = onCap
      ? volume
      : gainOf(dbAt((event.clientY - box.top) / box.height), floor);
    const cancel = (key: globalThis.KeyboardEvent) => {
      if (key.key !== "Escape") return;
      key.preventDefault();
      key.stopImmediatePropagation();
      end();
      reset();
    };
    window.addEventListener("keydown", cancel, true);
    drag.current = {
      y: event.clientY,
      from,
      next: from,
      fine: event.shiftKey,
      moved: !onCap,
      height: box.height,
      release: () => window.removeEventListener("keydown", cancel, true),
    };
    if (!onCap) draft(from);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const held = drag.current;
    if (!held) return;
    // Shift changed: carry on from the gain shown, without a jump.
    if (held.fine !== event.shiftKey) {
      held.from = held.next;
      held.y = event.clientY;
      held.fine = event.shiftKey;
    }
    const dy = event.clientY - held.y;
    if (!dy && !held.moved) return;
    held.moved = true;
    const db =
      held.from <= 0
        ? BOTTOM_DB
        : Math.max(BOTTOM_DB, audioGainToDb(held.from));
    held.next = held.fine
      ? gainOf(db - dy * 0.1, floor)
      : gainOf(dbAt(faderAt(held.from) + dy / held.height), floor);
    draft(held.next);
  };
  const onPointerUp = () => {
    const held = end();
    if (held?.moved) commit(held.next);
  };

  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    if (off) return;
    const current = keys.current?.next ?? volume;
    const db = current <= 0 ? BOTTOM_DB : audioGainToDb(current);
    const change =
      event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
    if (!change && event.key !== "Home") return;
    event.preventDefault();
    event.stopPropagation();
    const next =
      event.key === "Home"
        ? 1
        : gainOf(db + change * (event.shiftKey ? 0.1 : 1), floor);
    draft(next);
    // A run of presses saves once the keys rest.
    window.clearTimeout(keys.current?.timer);
    keys.current = {
      next,
      timer: window.setTimeout(() => {
        keys.current = null;
        commit(next);
      }, 400),
    };
  };

  return (
    <>
      <div
        className="mixer-fader"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          end();
          reset();
        }}
      >
        <div className="mixer-scale" aria-hidden>
          {TICKS.map((db) => (
            <span
              key={db}
              style={{ top: `${faderAt(audioDbToGain(db)) * 100}%` }}
            >
              {db > 0 ? `+${db}` : db}
            </span>
          ))}
        </div>
        <div className="mixer-track" ref={travel} />
        <div
          ref={cap}
          className="mixer-cap"
          role="slider"
          tabIndex={0}
          aria-label={`${model.code ?? model.name} gain`}
          aria-valuetext={`${valueText(volume)} dB`}
          aria-valuemin={floor > 0 ? -60 : -Infinity}
          aria-valuemax={12}
          aria-valuenow={volume > 0 ? audioGainToDb(volume) : -Infinity}
          aria-disabled={off ? "true" : undefined}
          title={off}
          style={{ top: `${faderAt(volume) * 100}%` }}
          onKeyDown={step}
          onDoubleClick={() => !off && commit(1)}
        />
        <div className="mixer-meter">
          {["L", "R"].map((side) => (
            <div key={side} className="mixer-channel">
              <button
                type="button"
                className="mixer-clip"
                aria-label={`Clear ${model.code ?? model.name} ${side} clipping indicator`}
                title={`Clear ${side} clipping indicator`}
                disabled
              />
              <i aria-hidden>
                <span />
                <b hidden />
              </i>
            </div>
          ))}
        </div>
      </div>
      <div
        className="mixer-value"
        data-unity={volume === 1 ? "" : undefined}
        onDoubleClick={() => !off && setTyping(true)}
      >
        {typing ? (
          <input
            aria-label={`${model.code ?? model.name} gain in dB`}
            autoFocus
            spellCheck={false}
            defaultValue={valueText(volume)}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={() => setTyping(false)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key !== "Enter" && event.key !== "Escape") return;
              event.preventDefault();
              if (event.key === "Enter")
                try {
                  const next = parseGain(event.currentTarget.value);
                  if (next > MAX_AUDIO_GAIN)
                    throw new Error("Gain goes up to +12 dB.");
                  commit(Math.max(floor, next));
                } catch (error) {
                  showToast(
                    error instanceof Error ? error.message : String(error),
                  );
                }
              setTyping(false);
            }}
          />
        ) : (
          <span>
            <span ref={value}>{valueText(volume)}</span>
            {model.automated && <small>Auto</small>}
          </span>
        )}
      </div>
    </>
  );
}

/** An automated bus's fader follows its lane while playing, from the preview's samples. */
function useAutomatedFader(
  model: StripModel,
  cap: RefObject<HTMLDivElement | null>,
  value: RefObject<HTMLSpanElement | null>,
  travel: RefObject<HTMLDivElement | null>,
) {
  const id = model.automated && model.bus ? model.bus.id : null;
  const { volume } = model;
  useEffect(() => {
    const range = travel.current;
    if (id === null || !range) return;
    // A playback sample can update the cap without reading layout.
    let height = range.clientHeight;
    const resized = new ResizeObserver(() => {
      height = range.clientHeight;
    });
    resized.observe(range);
    const unsubscribe = audioLevels.subscribe((level) => {
      const gain = level.faders?.[id];
      if (!cap.current || !value.current) return;
      cap.current.style.transform =
        level.playing && gain !== undefined
          ? `translateY(${(faderAt(gain) - faderAt(volume)) * height}px)`
          : "";
      const text = valueText(level.playing ? (gain ?? volume) : volume);
      if (value.current.textContent !== text) value.current.textContent = text;
    });
    return () => {
      unsubscribe();
      resized.disconnect();
    };
  }, [id, volume, cap, value, travel]);
}

/** One subscription for every strip's meter: one sample per strip per frame, no React. */
function useMeters(
  root: RefObject<HTMLDivElement | null>,
  strips: readonly StripModel[],
) {
  const keys = strips.map(({ key }) => key).join("\n");
  useEffect(() => {
    const meters = [
      ...(root.current?.querySelectorAll<HTMLElement>("[data-strip]") ?? []),
    ].map((strip) => ({
      key: strip.dataset.strip!,
      painter: meterPainter(
        [...strip.querySelectorAll<HTMLElement>(".mixer-channel")].map(
          (element) => ({
            element,
            lit: element.querySelector<HTMLElement>("i > span")!,
            peak: element.querySelector<HTMLElement>("i > b")!,
            clip: element.querySelector<HTMLButtonElement>(".mixer-clip")!,
          }),
        ),
        { draw: "slide" },
      ),
    }));
    const resized = new ResizeObserver(() => {
      for (const { painter } of meters) painter.measure();
    });
    if (root.current) resized.observe(root.current);
    const unsubscribe = audioLevels.subscribe((level) => {
      const now = performance.now();
      for (const { key, painter } of meters) {
        const sample =
          key === "main" ? level : (level.strips?.[key] ?? { l: 0, r: 0 });
        painter.paint([sample.l, sample.r], level.playing, now);
      }
    });
    return () => {
      unsubscribe();
      resized.disconnect();
      for (const { painter } of meters) painter.dispose();
    };
  }, [root, keys]);
}

/** A strip's effect rack, floating beside its strip: the same rack the Inspector shows. */
function Rack({
  anchor,
  name,
  fx,
  open,
  disabled,
  onChange,
  onClose,
}: {
  anchor: Element | null | undefined;
  name: string;
  fx: readonly FxNode[];
  open?: string;
  disabled: boolean;
  onChange(label: string, fx: FxInput[]): void;
  onClose(): void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element || !anchor) return;
    element.showPopover();
    const box = anchor.getBoundingClientRect();
    const mixer = anchor.closest(".mixer")?.getBoundingClientRect() ?? box;
    element.style.left = `${Math.max(0, box.left - element.offsetWidth)}px`;
    element.style.top = `${mixer.top}px`;
    // A manual popover, so choosing from the rack's own menus, which float outside it, keeps it
    // open. A press anywhere else or Esc closes it.
    const menu = ".select-menu, .context-menu";
    const press = (event: globalThis.PointerEvent) => {
      if (
        event.target instanceof Node &&
        !element.contains(event.target) &&
        !(event.target instanceof Element && event.target.closest(menu))
      )
        close.current();
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !document.querySelector(`:is(${menu}):popover-open`)
      )
        close.current();
    };
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("keydown", key);
    };
  }, [anchor]);
  return (
    <div
      ref={panel}
      className="mixer-rack"
      role="dialog"
      aria-label={`${name} effects`}
      popover="manual"
    >
      <h2>{name}</h2>
      <FxRack fx={fx} disabled={disabled} open={open} onChange={onChange} />
    </div>
  );
}
