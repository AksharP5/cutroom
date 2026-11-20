import {
  compositionDiagnosticsScript,
  compositionScriptSources,
} from "./diagnostics";
import type { DiagnosticWindow } from "./diagnostics";
import { parse } from "parse5";
import { ensureHfIds } from "@hyperframes/parsers/hf-ids";
import {
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
} from "@hyperframes/parsers/media-duration";
import type { DefaultTreeAdapterTypes } from "parse5";
import { exportClipWindow, parseFpsWithDefault } from "@hyperframes/core";
import { compositionClipLocations } from "../timeline/composition";
import type { CompositionScope } from "../timeline/composition";
import { TimelineError } from "../../shared/timeline/apply";
import { canonicalText } from "../../shared/timeline/schema";
import { previewTiming } from "./previewTiming";
import type { PreviewTiming } from "../../shared/preview";
import type { EditFrame } from "../../shared/preview";
import { frameSeek } from "../../shared/frames";
import type { FrameGrid } from "../../shared/frames";

interface PreviewWindow extends DiagnosticWindow {
  /** HyperFrames' codec facts for the project's media, by root-relative path. */
  __HF_MEDIA_CODEC_MAP__?: Record<string, { browserHostile?: boolean }>;
  CSSNumericValue: {
    parse(value: string): {
      toSum(): { values: Iterable<{ unit: string; value: number }> };
    };
  };
  gsap?: {
    ticker?: { tick?: () => void };
    getProperty(element: Element, property: string): unknown;
    getTweensOf?(target: Element): {
      progress(): number;
      vars: Record<string, unknown> & { startAt?: Record<string, unknown> };
    }[];
  };
  __hf?: Window["__hf"] & {
    /** The runtime's resolved window of a clip, in composition seconds. */
    clipWindow?: (element: Element) => { start: number; end: number } | null;
    audioMeter?: {
      start(): void;
      stop(): void;
      read(): {
        master: { l: number; r: number };
        groups: Record<string, { l: number; r: number }>;
      };
      /** Cutroom's adapter: a group's fader, or Main's trim when the id is null. */
      fade(id: string | null, gain: number): void;
      /** Where automation holds each of these groups' faders now. */
      faders(ids: string[]): Record<string, number>;
      /** Peaks of clips entering a bus, by their track index. */
      pre(): Record<string, { l: number; r: number }>;
      /** Disconnect those taps while the mixer is closed. */
      clearPre(): void;
    };
    /** HyperFrames' colour grading: graded pictures, and a compare that shows their source. */
    colorGrading?: {
      isGraded(target: Element): boolean;
      setGrading(target: Element, grade: null): boolean;
      setCompare(
        target: Element,
        compare: {
          enabled: boolean;
          position: number;
          softness: number;
          lineWidth: number;
        },
      ): boolean;
      refresh(clip?: Element): number;
      redraw(): void;
    };
  };
  __cutroomParkedMedia?: ReadonlyMap<HTMLMediaElement, unknown>;
  __player?: {
    play(): void;
    pause(): void;
    seek(time: number): void;
    getTime(): number;
    isPlaying(): boolean;
  };
  __cutroomSeekFrame?: (time: number) => Promise<void>;
  /** Replaced each time the runtime lays out the composition's clips again. */
  __clipManifest?: unknown;
  /** Without `videoFrames`, it settles everything except native video decodes. */
  __hfWaitForSeekCompletion?: (options?: {
    videoFrames?: boolean;
  }) => Promise<void>;
}

type LiveClip = Pick<
  PreviewTiming["clips"][number],
  "id" | "slot" | "body" | "space"
>;

/**
 * How a loaded document becomes a saved one in place, or why it must reload. Both lists
 * come from the server. Clips that stay keep their place, their other attributes and their
 * order. A clip that changed otherwise is removed and added again. Removed clips leave
 * with the whitespace they own; each added clip goes next to a neighbour that stays, or
 * that was added before it, in its gap. A gap with no clip that stays reloads.
 * Runs inside the preview too, so it uses nothing outside itself.
 */
export function liveUpdatePlan(
  current: readonly LiveClip[],
  next: readonly LiveClip[],
):
  | {
      remove: string[];
      insert: { id: string; after: string | null; before: string | null }[];
    }
  | { refuse: string } {
  const before = new Map(current.map((clip) => [clip.id, clip]));
  if (
    before.size !== current.length ||
    new Set(next.map((clip) => clip.id)).size !== next.length
  )
    return { refuse: "The preview clips are ambiguous." };
  const stays = (clip: LiveClip) => {
    const old = before.get(clip.id);
    return (
      !!old &&
      old.slot === clip.slot &&
      old.body === clip.body &&
      old.space === clip.space
    );
  };
  const kept = new Set(next.filter(stays).map((clip) => clip.id));
  const removed = current.filter((clip) => !kept.has(clip.id));
  const added = next.filter((clip) => !kept.has(clip.id));
  if ([...removed, ...added].some((clip) => clip.slot === null))
    return { refuse: "This clip is part of the document's structure." };
  if (
    current
      .filter((clip) => kept.has(clip.id))
      .some(
        (clip, index) =>
          clip.id !== next.filter((clip) => kept.has(clip.id))[index]!.id,
      )
  )
    return { refuse: "The clips changed order." };
  const after: { id: string; after: string; before: null }[] = [];
  const ahead: { id: string; after: null; before: string }[] = [];
  for (const [index, clip] of next.entries()) {
    if (kept.has(clip.id)) continue;
    const gap = next.filter((other) => other.slot === clip.slot);
    const first = gap.findIndex((other) => kept.has(other.id));
    if (first < 0) return { refuse: "Added clips need a fresh document." };
    // Clips in one gap are adjacent, so the neighbour in the list is the one in the page.
    if (gap.indexOf(clip) > first)
      after.push({ id: clip.id, after: next[index - 1]!.id, before: null });
    else ahead.push({ id: clip.id, after: null, before: next[index + 1]!.id });
  }
  // After a neighbour in list order; before one in reverse, so each anchor exists.
  return {
    remove: removed.map((clip) => clip.id),
    insert: [...after, ...ahead.reverse()],
  };
}

/** Runs inside the opaque preview. The only commands affect its own picture and playback. */
function installPreviewBridge(
  plan: typeof liveUpdatePlan,
  seekInFrame: typeof frameSeek,
  /** The pinned runtime's playback-rate bounds, so the bridge clamps rates as it does. */
  [minRate, maxRate]: [number, number],
  texts: [string, string[]][],
  initialTiming:
    | (Pick<
        PreviewTiming,
        "structure" | "revision" | "titleStyle" | "duration"
      > & {
        clips: (LiveClip & {
          titleAttributes: string[] | null;
          animated: boolean;
        })[];
      })
    | null,
  rampPending: boolean,
  rampWindows: [src: string, seconds: number][],
) {
  const rampFiles = new Map(rampWindows);
  const animatedTitles = new Set<string>();
  const titleAnimations = new Map<string, Set<Animation>>();
  let timingRevision = initialTiming?.revision;
  let titleStyle = initialTiming?.titleStyle;
  // The clips and length of the document as last confirmed; edits can add and remove clips.
  let liveClips = initialTiming?.clips ?? [];
  /**
   * Media this document removed, by clip id and the hash of its other attributes. Undo and
   * turning a clip back on add the same clip again; reusing its element keeps the media it
   * already loaded, where a new element would load it from scratch.
   */
  const removedMedia = new Map<string, HTMLMediaElement>();
  let updatingTiming = false;
  let confirmedStructure: string | null = null;
  // The bridge runs inside the page, so it names HyperFrames' attribute itself.
  const GRADE_ATTRIBUTE = "data-color-grading";
  /**
   * The saved `data-color-grading` of each clip with a grade draft showing. HyperFrames' runtime
   * watches the attribute and redraws the clip; the structure comparison reads the saved value.
   */
  const gradeSaved = new Map<Element, string | null>();
  // Attribute writes made by the pinned runtime for a parent seek or playback may change
  // visibility. Remember their exact before/after values without cloning per frame. The
  // runtime can apply a seek after its images decode, so the record runs until it settles.
  // An outside write before or after that must still fail the DOM comparison.
  const seekAttributes = new Map<
    Element,
    Map<string, { before: string | null; after: string | null }>
  >();
  let seekDiverged = false;
  let seekGeneration = 0;
  let recording = false;
  const recordSeek = (records: MutationRecord[]) => {
    const seen = new Map<Element, Set<string>>();
    for (const record of records) {
      const element = record.target;
      const name = record.attributeName;
      if (!(element instanceof Element) || !name) continue;
      // Decoded-frame handoff flags and canvases can finish asynchronously and are
      // already excluded from the divergence comparison below.
      if (
        (element === document.documentElement &&
          (name === "data-hf-preview-seek-hold" ||
            name === "data-cutroom-media-corrections")) ||
        (element.tagName === "VIDEO" &&
          (name === "data-cutroom-held" || name === "data-cutroom-flow")) ||
        (element instanceof HTMLMediaElement && name === "preload") ||
        element.matches(
          "[data-cutroom-video-hold], [data-cutroom-edit-frame]",
        ) ||
        (element.matches("hf-audio-group[data-cutroom-track]") &&
          name === "data-volume")
      )
        continue;
      const names = seen.get(element) ?? new Set<string>();
      if (names.has(name)) continue;
      names.add(name);
      seen.set(element, names);
      const attributes =
        seekAttributes.get(element) ??
        new Map<string, { before: string | null; after: string | null }>();
      const prior = attributes.get(name);
      if (prior && prior.after !== record.oldValue) seekDiverged = true;
      attributes.set(name, {
        before: prior ? prior.before : record.oldValue,
        after: element.getAttribute(name),
      });
      seekAttributes.set(element, attributes);
    }
  };
  // Records delivered after a seek returns reach the callback; the rest are taken directly.
  const seekMutations = new MutationObserver(recordSeek);
  const flushSeek = () => recordSeek(seekMutations.takeRecords());
  /** Ends the current record, so the bridge's own writes that follow are not the seek's. */
  const stopRecording = () => {
    flushSeek();
    seekMutations.disconnect();
    recording = false;
    seekGeneration += 1;
  };
  /** Starts recording the runtime's writes, for a seek or for playback. */
  const recordRuntime = () => {
    if (!initialTiming || confirmedStructure === null) return null;
    seekMutations.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeOldValue: true,
    });
    recording = true;
    return ++seekGeneration;
  };
  /** Ends the record once the runtime has drawn the frame it is settling on. */
  const settleRecording = (generation: number) => {
    // The runtime keeps the old clips visible until the new ones have decoded a frame.
    const settled = win.__hfWaitForSeekCompletion?.();
    if (!settled) {
      if (generation === seekGeneration) stopRecording();
      return;
    }
    void settled
      .catch(() => {})
      .then(() => new Promise((resolve) => requestAnimationFrame(resolve)))
      .then(() => {
        if (generation === seekGeneration) stopRecording();
      });
  };
  /** Resolves once the runtime has laid out its clips again since it published `manifest`. */
  const layoutPass = (manifest: unknown) =>
    new Promise<void>((resolve, reject) => {
      const deadline = performance.now() + 1000;
      const check = () => {
        if (retired) reject(new Error("The preview document was retired."));
        else if (win.__clipManifest !== manifest) resolve();
        else if (performance.now() > deadline)
          reject(new Error("The runtime did not lay out the added clips."));
        else requestAnimationFrame(check);
      };
      check();
    });
  const seekRuntime = (time: number) => {
    const generation = recordRuntime();
    try {
      win.__player?.seek(time);
    } finally {
      if (generation !== null) {
        flushSeek();
        settleRecording(generation);
      }
    }
  };
  /** Faders a saved gain sets in place: Cutroom's track buses and buses without automation. */
  const FADERS =
    "hf-audio-group[id]:is([data-cutroom-track], :not([data-automation]))";
  /** Matches the server's choice: a bus's level must be within one gain stage, +12 dB. */
  const isFader = (element: Element) => {
    if (!element.matches(FADERS)) return false;
    if (element.hasAttribute("data-cutroom-track")) return true;
    const level = Number(element.getAttribute("data-volume") ?? 1);
    return level >= 0 && level <= 3.9810717055349722;
  };
  const faders = (root: ParentNode) =>
    [...root.querySelectorAll(FADERS)].filter(isFader);
  /** The copy of a live element in a clone of the document, found by its path from the root. */
  const cloneOf = (root: Element, element: Element) => {
    const path: number[] = [];
    let node: Node | null = element;
    while (node && node !== document.documentElement) {
      const parentNode: ParentNode | null = node.parentNode;
      if (!parentNode) break;
      path.unshift([...parentNode.childNodes].indexOf(node as ChildNode));
      node = parentNode;
    }
    if (node !== document.documentElement)
      throw new Error("The live preview element changed.");
    const clone = path.reduce<Node>(
      (node, index) => node.childNodes[index]!,
      root,
    );
    if (!(clone instanceof Element))
      throw new Error("The live preview element changed.");
    return clone;
  };
  const liveStructure = () => {
    flushSeek();
    if (seekDiverged)
      throw new Error("The live preview changed between seeks.");
    const root = document.documentElement.cloneNode(true);
    if (!(root instanceof Element))
      throw new Error("The preview document is unavailable.");
    // A grade draft shows in the page but is not saved yet: compare the saved grade.
    for (const [element, saved] of gradeSaved) {
      if (!element.isConnected) {
        gradeSaved.delete(element);
        continue;
      }
      const clone = cloneOf(root, element);
      if (saved === null) clone.removeAttribute(GRADE_ATTRIBUTE);
      else clone.setAttribute(GRADE_ATTRIBUTE, saved);
    }
    for (const [element, attributes] of seekAttributes) {
      // An edit removed it; nothing of it remains to compare.
      if (!element.isConnected) {
        seekAttributes.delete(element);
        continue;
      }
      const clone = cloneOf(root, element);
      for (const [name, { before, after }] of attributes) {
        if (element.getAttribute(name) !== after)
          throw new Error(`The live preview attribute ${name} changed.`);
        if (before === null) clone.removeAttribute(name);
        else clone.setAttribute(name, before);
      }
    }
    root.removeAttribute("data-hf-preview-seek-hold");
    root.removeAttribute("data-cutroom-media-corrections");
    // These canvases and flags belong to this bridge, not the composition.
    for (const hold of root.querySelectorAll(
      "[data-cutroom-video-hold], [data-cutroom-edit-frame]",
    ))
      hold.remove();
    for (const video of root.querySelectorAll("video")) {
      video.removeAttribute("data-cutroom-held");
      video.removeAttribute("data-cutroom-flow");
    }
    // The runtime raises media near the playhead to preload on its own schedule. It
    // decides only what loads early, never what plays or shows. "none" also keeps these
    // cloned elements from loading their media.
    for (const media of root.querySelectorAll("video, audio"))
      media.setAttribute("preload", "none");
    // Gain checks and timing updates both set these faders in place.
    for (const group of faders(root)) group.removeAttribute("data-volume");
    for (const element of [root, ...root.querySelectorAll("*")]) {
      const attributes = [...element.attributes].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const { name } of attributes) element.removeAttribute(name);
      for (const { name, value } of attributes)
        element.setAttribute(name, value);
    }
    return root.outerHTML;
  };
  const sourceTexts = new Map(texts);
  const titleNodes = (element: Element) =>
    [...element.childNodes].map((node) =>
      node.nodeType === Node.TEXT_NODE
        ? (node.nodeValue ?? "")
        : {
            br:
              node instanceof Element ? node.getAttribute("data-hf-id") : null,
          },
    );
  const canonicalWords = (text: string) =>
    text
      .split(/\r\n?|\n/)
      .map((line) => line.replace(/[\t\f ]+/g, " ").replace(/^ | $/g, ""))
      .join("\n")
      .replace(/^\n+|\n+$/g, "");
  /** Validates a transform style message from the editor: each longhand is a string or null. */
  const transformCss = (value: unknown): TransformCss | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const css: TransformCss = { scale: null, rotate: null, "clip-path": null };
    for (const property of ["scale", "rotate", "clip-path"] as const) {
      const item: unknown = Reflect.get(value, property);
      if (item !== null && typeof item !== "string") return undefined;
      css[property] = item;
    }
    return css;
  };
  const clipElement = (id: string) =>
    document.querySelector(`[data-hf-cutroom-clip-id="${CSS.escape(id)}"]`);
  /** Resolves every fader in this document, or null when the set differs. */
  const trackGains = (gains: unknown) => {
    if (!Array.isArray(gains)) return null;
    const changes: { element: Element; volume: string }[] = [];
    for (const gain of gains) {
      if (
        !gain ||
        typeof gain !== "object" ||
        !("id" in gain) ||
        typeof gain.id !== "string" ||
        !("volume" in gain) ||
        typeof gain.volume !== "number" ||
        !Number.isFinite(gain.volume) ||
        gain.volume < 0
      )
        return null;
      const element = document.getElementById(gain.id);
      if (!element || !isFader(element)) return null;
      changes.push({ element, volume: String(gain.volume) });
    }
    return new Set(changes.map(({ element }) => element)).size ===
      faders(document).length
      ? changes
      : null;
  };
  const win = window as PreviewWindow;
  // Finished entrance effects disappear from getAnimations(), but the pinned runtime
  // can still retain their handles. Collect them before the parent's first seek.
  const rememberTitleAnimations = () => {
    if (!initialTiming || !win.__player) return;
    for (const clip of liveClips) {
      if (!clip.titleAttributes) continue;
      const element = clipElement(clip.id);
      if (!element) continue;
      const handles = titleAnimations.get(clip.id) ?? new Set<Animation>();
      for (const animation of element.getAnimations()) handles.add(animation);
      titleAnimations.set(clip.id, handles);
    }
  };
  const positions = new Map<
    HTMLElement | SVGElement,
    { translate: string; priority: string; base: string; x: number; y: number }
  >();
  let positionFrame = 0;
  let positionDraft: {
    clipId: string;
    x: number | null;
    y: number | null;
  } | null = null;
  const splitTranslate = (value: string) => {
    const parts: string[] = [];
    let depth = 0;
    let part = "";
    for (const char of value) {
      if (char === "(") depth++;
      if (char === ")") depth--;
      if (/\s/.test(char) && depth === 0) {
        if (part) parts.push(part);
        part = "";
      } else part += char;
    }
    if (part) parts.push(part);
    return parts;
  };
  const writePosition = () => {
    positionFrame = 0;
    const draft = positionDraft;
    if (!draft) return;
    const element = clipElement(draft.clipId);
    if (!(element instanceof HTMLElement || element instanceof SVGElement))
      return;
    let original = positions.get(element);
    if (!original) {
      win.gsap?.getProperty(element, "x");
      const number = (name: string) =>
        Number.parseFloat(element.getAttribute(name) ?? "0") || 0;
      original = {
        translate: element.style.getPropertyValue("translate"),
        priority: element.style.getPropertyPriority("translate"),
        base: getComputedStyle(element).translate,
        x: element.hasAttribute("data-hf-edit-base-x")
          ? number("data-x") - number("data-hf-edit-base-x")
          : 0,
        y: element.hasAttribute("data-hf-edit-base-y")
          ? number("data-y") - number("data-hf-edit-base-y")
          : 0,
      };
      positions.set(element, original);
    }
    let translate = original.translate;
    if (draft.x !== null && draft.y !== null) {
      const parts = splitTranslate(
        original.base === "none" ? "" : original.base,
      );
      translate = `calc(${parts[0] ?? "0px"} + ${draft.x - original.x}px) calc(${parts[1] ?? "0px"} + ${draft.y - original.y}px)${parts[2] ? ` ${parts[2]}` : ""}`;
    }
    // The parked video is represented by its held canvas. Both share the same style.
    element.style.setProperty("translate", translate, original.priority);
    if (element instanceof HTMLVideoElement)
      holds
        .get(element)
        ?.canvas.style.setProperty("translate", translate, original.priority);
    if (draft.x === null) positions.delete(element);
    scheduleBox();
    clearTimeout(observationTimer);
    if (observedClip)
      observationTimer = window.setTimeout(scheduleObservation, 350);
  };
  type TransformCss = Record<"scale" | "rotate" | "clip-path", string | null>;
  const transformProperties = ["scale", "rotate", "clip-path"] as const;
  const transforms = new Map<
    HTMLElement | SVGElement,
    Record<keyof TransformCss, { value: string; priority: string }>
  >();
  let transformFrame = 0;
  let transformDraft: {
    clipId: string;
    style: TransformCss | null;
    /** The same draft relative to the saved values, which GSAP folded into its transform. */
    onGsap: TransformCss;
  } | null = null;
  const setTransform = (
    element: HTMLElement | SVGElement,
    property: keyof TransformCss,
    value: string,
    priority: string,
  ) => {
    // The parked video is represented by its held canvas. Both share the same style.
    for (const target of [
      element,
      element instanceof HTMLVideoElement ? holds.get(element)?.canvas : null,
    ])
      if (value) target?.style.setProperty(property, value, priority);
      else target?.style.removeProperty(property);
  };
  const restoreTransform = (element: HTMLElement | SVGElement) => {
    const original = transforms.get(element);
    if (!original) return;
    for (const property of transformProperties)
      setTransform(
        element,
        property,
        original[property].value,
        original[property].priority,
      );
    transforms.delete(element);
  };
  const writeTransform = () => {
    transformFrame = 0;
    const draft = transformDraft;
    if (!draft) return;
    const element = clipElement(draft.clipId);
    if (!(element instanceof HTMLElement || element instanceof SVGElement))
      return;
    if (!draft.style) restoreTransform(element);
    else {
      let original = transforms.get(element);
      if (!original) {
        // Parse now, as Position drafts do, so GSAP folds only the saved values into its
        // transform and never a draft. It leaves each longhand at "none".
        win.gsap?.getProperty(element, "x");
        original = {
          scale: { value: "", priority: "" },
          rotate: { value: "", priority: "" },
          "clip-path": { value: "", priority: "" },
        };
        for (const property of transformProperties)
          original[property] = {
            value: element.style.getPropertyValue(property),
            priority: element.style.getPropertyPriority(property),
          };
        transforms.set(element, original);
      }
      for (const property of transformProperties) {
        const folded = "_gsap" in element && property !== "clip-path";
        setTransform(
          element,
          property,
          (folded ? draft.onGsap[property] : draft.style[property]) ??
            (folded ? "none" : ""),
          original[property].priority,
        );
      }
    }
    scheduleBox();
    clearTimeout(observationTimer);
    if (observedClip)
      observationTimer = window.setTimeout(scheduleObservation, 350);
  };
  /**
   * A keyframed property's draft. Its animation draws over inline styles, so the draft is written
   * as important, which outranks animations, and GSAP never parses the clip to fold it.
   */
  const keyframeProperties = [
    "translate",
    "scale",
    "rotate",
    "clip-path",
    "opacity",
  ] as const;
  const keyframeOriginals = new Map<
    HTMLElement | SVGElement,
    Map<string, { value: string; priority: string }>
  >();
  const writeKeyframe = (clipId: string, style: Map<string, string> | null) => {
    const element = clipElement(clipId);
    if (!(element instanceof HTMLElement || element instanceof SVGElement))
      return;
    const original = keyframeOriginals.get(element) ?? new Map();
    keyframeOriginals.set(element, original);
    for (const property of style?.keys() ?? [])
      if (!original.has(property))
        original.set(property, {
          value: element.style.getPropertyValue(property),
          priority: element.style.getPropertyPriority(property),
        });
    for (const [property, saved] of original) {
      const value = style?.get(property);
      for (const target of [
        element,
        element instanceof HTMLVideoElement ? holds.get(element)?.canvas : null,
      ]) {
        if (value !== undefined)
          target?.style.setProperty(property, value, "important");
        else if (saved.value)
          target?.style.setProperty(property, saved.value, saved.priority);
        else target?.style.removeProperty(property);
      }
    }
    if (!style) keyframeOriginals.delete(element);
    scheduleBox();
  };
  /**
   * Region CSS the editor draws over the saved stylesheet while a box is dragged. It comes last in
   * the head, so its rules win over the saved ones they repeat.
   */
  let regionDraft: HTMLStyleElement | null = null;
  const writeRegion = (css: string | null) => {
    if (css === null) {
      regionDraft?.remove();
      regionDraft = null;
      return;
    }
    regionDraft ??= document.createElement("style");
    regionDraft.setAttribute("data-cutroom-region-draft", "");
    if (regionDraft.textContent !== css) regionDraft.textContent = css;
    if (regionDraft !== document.head.lastElementChild)
      document.head.append(regionDraft);
  };
  const writeGradeDraft = (
    clipId: string,
    attribute: string | null,
    restore: boolean,
  ) => {
    const element = clipElement(clipId);
    if (!element) return;
    if (!gradeSaved.has(element)) {
      if (restore) return;
      gradeSaved.set(element, element.getAttribute(GRADE_ATTRIBUTE));
    }
    const value = restore ? gradeSaved.get(element)! : attribute;
    if (restore) gradeSaved.delete(element);
    if (element.getAttribute(GRADE_ATTRIBUTE) === value) return;
    if (value === null) element.removeAttribute(GRADE_ATTRIBUTE);
    else element.setAttribute(GRADE_ATTRIBUTE, value);
    const video = element instanceof HTMLVideoElement ? element : null;
    if (video && parked.has(video)) return;
    // Let the runtime's graded canvas replace the held copy while a grade is active.
    if (video && value !== null && holds.has(video)) removeHold(video);
    // Draw the changed clip now. The runtime skips its duplicate attribute notification.
    const grading = win.__hf?.colorGrading;
    grading?.refresh(element);
    if (!video || grading?.isGraded(video) || win.__player?.isPlaying()) return;
    // Native video and the held frame can decode untagged colour differently. Restore
    // the hold after any pending seek, provided the video is still showing its source.
    const version = pictureVersion;
    const ungraded = () =>
      video.isConnected && !parked.has(video) && !grading?.isGraded(video);
    picture = picture.then(() => {
      if (
        !holds.has(video) &&
        video.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      )
        return holdPaused(version, ungraded);
    });
    void picture.catch(reportFrameFailure);
  };
  /** Before/after: every graded picture shows its source, through the runtime's own compare. */
  let gradeBypass = false;
  const writeGradeBypass = () => {
    const grading = win.__hf?.colorGrading;
    if (!grading) return;
    for (const element of document.querySelectorAll(`[${GRADE_ATTRIBUTE}]`)) {
      if (element instanceof HTMLVideoElement && parked.has(element)) continue;
      grading.setCompare(element, {
        enabled: gradeBypass,
        position: 1,
        softness: 0,
        lineWidth: 0,
      });
    }
  };
  let observedClip: string | null = null;
  let observedText: string | null = null;
  /** The clip's saved transform longhands, which the warning compares while no draft shows. */
  let observedTransform: TransformCss | null = null;
  const cssProbe = document.createElement("div").style;
  /** Numbers and words of two values agree once the browser serializes both the same way:
   * `inset(0px 8px 0px 8px)` computes as `inset(0px 8px)`, and `scale: 2` reads as `2 2`. */
  const sameCss = (
    property: string,
    computed: string,
    saved: string,
  ): boolean => {
    const serialize = (value: string) => {
      cssProbe.setProperty(property, value);
      return cssProbe.getPropertyValue(property) || value;
    };
    const actual = serialize(computed);
    const expected = serialize(saved);
    const numbers = (value: string) => {
      const found = (
        value.match(/-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/gi) ?? []
      ).map(Number);
      return found.length === 1 && !/[a-z(]/i.test(value)
        ? [found[0]!, found[0]!]
        : found;
    };
    const words = (value: string) =>
      value
        .replace(/-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/gi, "#")
        .replace(/\s+/g, " ");
    const [a, b] = [numbers(actual), numbers(expected)];
    return (
      words(actual) === words(expected) &&
      a.length === b.length &&
      a.every((value, index) => Math.abs(value - b[index]!) < 0.0001)
    );
  };
  /** Which saved or drafted transform longhands the composition's own styles or animation replace. */
  const overriddenTransform = (
    element: HTMLElement | SVGElement,
    picture: Element,
  ) => {
    const expected =
      transformDraft?.clipId === observedClip
        ? transformDraft.style
        : observedTransform;
    if (!expected) return [];
    const style = getComputedStyle(picture);
    // GSAP folds the longhands into its own transform once it parses the element, so there
    // only a tween that writes scale or rotation can replace them.
    const tweens =
      "_gsap" in element ? (win.gsap?.getTweensOf?.(element) ?? []) : null;
    const keys = {
      scale: ["scale", "scaleX", "scaleY", "transform"],
      rotate: ["rotation", "rotate", "rotationZ", "rotateZ", "transform"],
    };
    const names = { scale: "Scale", rotate: "Rotation", "clip-path": "Crop" };
    return transformProperties.flatMap((property) => {
      const value = expected[property];
      if (value === null) return [];
      if (tweens && property !== "clip-path")
        return tweens.some(
          (tween) =>
            keys[property].some(
              (key) => key in tween.vars || key in (tween.vars.startAt ?? {}),
            ) &&
            (tween.progress() > 0 ||
              Boolean(tween.vars.runBackwards || tween.vars.startAt)),
        )
          ? [names[property]]
          : [];
      return sameCss(property, style.getPropertyValue(property), value)
        ? []
        : [names[property]];
    });
  };
  const checkText = () => {
    if (!observedClip || observedText === null) return;
    // A saved edit can be observed before its replacement document is promoted. Only compare
    // against the document containing that source, never the held picture of an earlier edit.
    if (!sourceTexts.get(observedClip)?.includes(observedText)) return;
    const element = clipElement(observedClip);
    if (!element) return;
    // Read the painted text nodes rather than innerText's CSS text-transform result: a
    // capitalized title still contains the committed words. Keep authored <br> boundaries.
    const preserveLines = /^(?:pre|pre-wrap|pre-line|break-spaces)$/.test(
      getComputedStyle(element).whiteSpace,
    );
    const words = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue ?? "";
        return preserveLines ? text : text.replace(/[\t\n\f\r ]+/g, " ");
      }
      if (node instanceof HTMLElement && node.tagName === "BR") return "\n";
      return [...node.childNodes].map(words).join("");
    };
    const rendered = canonicalWords(words(element));
    parent.postMessage(
      {
        source: "cutroom-preview",
        type: "text-warning",
        clipId: observedClip,
        text: observedText,
        time: win.__player?.getTime() ?? 0,
        overridden:
          element.checkVisibility({ checkVisibilityCSS: true }) &&
          rendered !== observedText,
      },
      "*",
    );
  };
  let observationTimer = 0;
  let observingPosition = false;
  let observationFrame = 0;
  let foldedClip: string | null = null;
  // This self-contained iframe script cannot import core's composeTranslate and its
  // private helpers. Compare the same baseline + pixel delta as numeric CSS sums,
  // preserving percentages, without adding a layout probe to the document.
  const translateMatches = (
    original: string,
    x: number,
    y: number,
    actual: string,
    style: CSSStyleDeclaration,
  ) => {
    const baseline = splitTranslate(original === "none" ? "" : original);
    const current = splitTranslate(actual === "none" ? "" : actual);
    const lengths = (value: string) => {
      const result = new Map<string, number>();
      for (const term of win.CSSNumericValue.parse(value).toSum().values) {
        let { unit, value } = term;
        if (unit === "em" || unit === "rem") {
          value *= Number.parseFloat(
            unit === "em"
              ? style.fontSize
              : getComputedStyle(document.documentElement).fontSize,
          );
          unit = "px";
        }
        result.set(unit, (result.get(unit) ?? 0) + value);
      }
      return result;
    };
    try {
      return [x, y, 0].every((delta, axis) => {
        const expected = lengths(baseline[axis] ?? "0px");
        expected.set("px", (expected.get("px") ?? 0) + delta);
        const rendered = lengths(current[axis] ?? "0px");
        return [...new Set([...expected.keys(), ...rendered.keys()])].every(
          (unit) =>
            Math.abs((expected.get(unit) ?? 0) - (rendered.get(unit) ?? 0)) <
            0.0001,
        );
      });
    } catch {
      // CSS math that Typed OM cannot resolve is not evidence that Position holds.
      return false;
    }
  };
  const checkPosition = (foldedId?: string | null) => {
    observingPosition = false;
    if (!observedClip) return;
    performance.mark("cutroom:position-observation:start");
    try {
      const element = clipElement(observedClip);
      if (!(element instanceof HTMLElement || element instanceof SVGElement))
        return;
      const number = (name: string) =>
        Number.parseFloat(element.getAttribute(name) ?? "0") || 0;
      const draft =
        positionDraft?.clipId === observedClip ? positionDraft : null;
      const edited =
        element.hasAttribute("data-hf-edit-base-x") ||
        element.hasAttribute("data-hf-edit-base-y");
      const x =
        draft?.x ??
        (edited ? number("data-x") - number("data-hf-edit-base-x") : 0);
      const y =
        draft?.y ??
        (edited ? number("data-y") - number("data-hf-edit-base-y") : 0);
      const transformed = Object.values(
        (transformDraft?.clipId === observedClip
          ? transformDraft.style
          : observedTransform) ?? {},
      ).some((value) => value !== null);
      observingPosition = Boolean(x || y) || transformed;
      let overridden = false;
      const picture =
        element instanceof HTMLVideoElement
          ? (holds.get(element)?.canvas ?? element)
          : element;
      if ((x || y) && picture.checkVisibility({ checkVisibilityCSS: true })) {
        const style = getComputedStyle(picture);
        const saved = positions.get(element);
        const original =
          saved?.base ??
          element.getAttribute("data-hf-edit-original-translate") ??
          "none";
        const dx = saved ? x - saved.x : x;
        const dy = saved ? y - saved.y : y;
        overridden = !translateMatches(
          original,
          dx,
          dy,
          style.translate,
          style,
        );
        if (foldedId && element.getAttribute("data-hf-id") === foldedId)
          overridden = true;
        // `translate` composes outside the clip's own scale, rotate and transform, so only
        // zoom on the clip itself changes the offset; any ancestor transform does too.
        overridden ||=
          style.zoom !== "normal" &&
          Math.abs(Number.parseFloat(style.zoom) - 1) > 0.000001;
        for (
          let ancestor = picture.parentElement;
          ancestor && !overridden;
          ancestor = ancestor.parentElement
        ) {
          const css = getComputedStyle(ancestor);
          const matrix = new DOMMatrixReadOnly(
            css.transform === "none" ? undefined : css.transform,
          );
          const linear = [
            matrix.m11 - 1,
            matrix.m12,
            matrix.m13,
            matrix.m14,
            matrix.m21,
            matrix.m22 - 1,
            matrix.m23,
            matrix.m24,
            matrix.m31,
            matrix.m32,
            matrix.m33 - 1,
            matrix.m34,
            matrix.m44 - 1,
          ];
          overridden =
            linear.some((value) => Math.abs(value) > 0.000001) ||
            (css.zoom !== "normal" &&
              Math.abs(Number.parseFloat(css.zoom) - 1) > 0.000001) ||
            (css.scale !== "none" &&
              css.scale
                .split(/\s+/)
                .some(
                  (value) =>
                    Math.abs(
                      Number.parseFloat(value) /
                        (value.endsWith("%") ? 100 : 1) -
                        1,
                    ) > 0.000001,
                )) ||
            (css.rotate !== "none" &&
              Math.abs(
                Number.parseFloat(css.rotate.split(/\s+/).at(-1)!) % 360,
              ) > 0.000001);
        }
      }
      parent.postMessage(
        {
          source: "cutroom-preview",
          type: "position-warning",
          clipId: observedClip,
          time: win.__player?.getTime() ?? 0,
          overridden: [
            ...(overridden ? ["Position"] : []),
            ...(transformed &&
            picture.checkVisibility({ checkVisibilityCSS: true })
              ? overriddenTransform(element, picture)
              : []),
          ],
        },
        "*",
      );
    } finally {
      performance.measure(
        "cutroom:position-observation",
        "cutroom:position-observation:start",
      );
      performance.clearMarks("cutroom:position-observation:start");
      performance.clearMeasures("cutroom:position-observation");
    }
  };
  const scheduleObservation = (foldedId?: string | null) => {
    if (foldedId) foldedClip = foldedId;
    if (!observedClip) {
      cancelAnimationFrame(observationFrame);
      observationFrame = 0;
      clearTimeout(observationTimer);
      observingPosition = false;
      foldedClip = null;
      return;
    }
    if (observationFrame) return;
    const frame = requestAnimationFrame(() => {
      const version = pictureVersion;
      void picture.then(
        () => {
          if (observationFrame !== frame) return;
          observationFrame = 0;
          // Check again after a newer seek settles, or after a draft still waiting for its
          // frame reaches the picture: until then the draft and the picture disagree.
          if (version !== pictureVersion || positionFrame || transformFrame) {
            scheduleObservation();
            return;
          }
          checkText();
          checkPosition(foldedClip);
          foldedClip = null;
          observePlaying();
        },
        () => {
          // The owning seek/paint request reports picture failures.
          if (observationFrame === frame) observationFrame = 0;
        },
      );
    });
    observationFrame = frame;
  };
  const observePlaying = () => {
    clearTimeout(observationTimer);
    if (
      !observedClip ||
      (!observingPosition && observedText === null) ||
      !win.__player?.isPlaying()
    )
      return;
    observationTimer = window.setTimeout(() => {
      scheduleObservation();
    }, 350);
  };
  type Box = { x: number; y: number; width: number; height: number };
  /** A clip's box in composition pixels: the iframe's viewport is the composition's frame. */
  const boxOf = (element: Element, opaque = false): Box | null => {
    const picture =
      element instanceof HTMLVideoElement
        ? (holds.get(element)?.canvas ?? element)
        : element;
    if (
      !picture.checkVisibility({
        checkVisibilityCSS: true,
        checkOpacity: opaque,
      })
    )
      return null;
    let { left, top, right, bottom } = picture.getBoundingClientRect();
    if (right <= left || bottom <= top) {
      // A clip that only positions its children has no box of its own.
      left = top = Infinity;
      right = bottom = -Infinity;
      for (const child of picture.querySelectorAll("*")) {
        const rect = child.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        left = Math.min(left, rect.left);
        top = Math.min(top, rect.top);
        right = Math.max(right, rect.right);
        bottom = Math.max(bottom, rect.bottom);
      }
      if (right <= left) return null;
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
  };
  let postedBox = "";
  /** Tells the editor where the observed clip is. Only a moved or resized box is sent. */
  const postBox = () => {
    if (!observedClip) return;
    const start = performance.now();
    const box = boxElement ? boxOf(boxElement) : null;
    performance.measure("cutroom:clip-box", { start, end: performance.now() });
    performance.clearMeasures("cutroom:clip-box");
    const key = box
      ? `${observedClip} ${box.x} ${box.y} ${box.width} ${box.height}`
      : observedClip;
    if (key === postedBox) return;
    postedBox = key;
    parent.postMessage(
      {
        source: "cutroom-preview",
        type: "clip-box",
        clipId: observedClip,
        box,
      },
      "*",
    );
  };
  let boxFrame = 0;
  let boxElement: Element | null = null;
  let boxAnimations: Animation[] = [];
  const scheduleBox = () => {
    if (observedClip && !boxFrame) boxFrame = requestAnimationFrame(followBox);
  };
  // Only CSS/Web Animations need continuous reads. GSAP and script changes invalidate the
  // cached box through mutations, so a stationary clip does no work per playback frame.
  const refreshBoxAnimations = () => {
    boxAnimations = boxElement?.getAnimations({ subtree: true }) ?? [];
    for (
      let ancestor = boxElement?.parentElement;
      ancestor;
      ancestor = ancestor.parentElement
    )
      boxAnimations.push(...ancestor.getAnimations());
    scheduleBox();
  };
  const followBox = () => {
    const frame = boxFrame;
    const version = pictureVersion;
    // A seek may still be replacing the held video. Read the settled picture once, with
    // the other geometry reads, instead of flushing layout between its style writes.
    void picture.then(
      () => {
        if (boxFrame !== frame) return;
        boxFrame = 0;
        if (version !== pictureVersion || positionFrame || transformFrame) {
          scheduleBox();
          return;
        }
        postBox();
        if (
          boxAnimations.some((animation) => animation.playState === "running")
        )
          scheduleBox();
      },
      () => {
        // The owning seek/paint request reports picture failures.
        if (boxFrame === frame) boxFrame = 0;
      },
    );
  };
  const boxMutations = new MutationObserver((records) => {
    if (
      records.some(
        (record) =>
          record.type !== "attributes" ||
          record.oldValue !==
            (record.target as Element).getAttribute(record.attributeName!),
      )
    )
      scheduleBox();
  });
  const boxResize = new ResizeObserver(scheduleBox);
  const observeBox = () => {
    boxMutations.disconnect();
    boxResize.disconnect();
    cancelAnimationFrame(boxFrame);
    boxFrame = 0;
    boxAnimations = [];
    boxElement = observedClip ? clipElement(observedClip) : null;
    if (!boxElement) {
      scheduleBox();
      return;
    }
    boxMutations.observe(boxElement, {
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      childList: true,
      characterData: true,
    });
    boxResize.observe(boxElement);
    for (
      let ancestor = boxElement.parentElement;
      ancestor;
      ancestor = ancestor.parentElement
    )
      boxMutations.observe(ancestor, {
        attributes: true,
        attributeOldValue: true,
      });
    refreshBoxAnimations();
  };
  // Delayed CSS animations and transitions can start without changing an inline attribute.
  for (const event of [
    "animationstart",
    "animationend",
    "animationcancel",
    "transitionrun",
    "transitionend",
    "transitioncancel",
  ])
    document.addEventListener(
      event,
      (event) => {
        const target = event.target;
        if (
          target instanceof Element &&
          boxElement &&
          (boxElement.contains(target) || target.contains(boxElement))
        )
          refreshBoxAnimations();
      },
      true,
    );
  addEventListener("resize", scheduleBox);
  /** Recover local border coordinates from the complete affine transform, including ancestors.
   * Layout offsets and transform origins only translate the quad; its bounding box anchors it.
   */
  const localPoint = (
    element: Element,
    x: number,
    y: number,
    styleOf: (element: Element) => CSSStyleDeclaration,
  ) => {
    const style = styleOf(element);
    const number = (name: string) =>
      Number.parseFloat(style.getPropertyValue(name)) || 0;
    const extra = (axis: "width" | "height") =>
      style.boxSizing === "border-box"
        ? 0
        : (axis === "width" ? ["left", "right"] : ["top", "bottom"]).reduce(
            (sum, side) =>
              sum + number(`padding-${side}`) + number(`border-${side}-width`),
            0,
          );
    const width = number("width") + extra("width");
    const height = number("height") + extra("height");
    let matrix = new DOMMatrix();
    for (let node: Element | null = element; node; node = node.parentElement) {
      const css = styleOf(node);
      let transform = new DOMMatrix(
        css.transform === "none" ? undefined : css.transform,
      );
      if (css.scale !== "none") {
        const scales = css.scale
          .split(/\s+/)
          .map(
            (value) =>
              Number.parseFloat(value) / (value.endsWith("%") ? 100 : 1),
          );
        transform = new DOMMatrix()
          .scale(scales[0]!, scales[1] ?? scales[0]!)
          .multiply(transform);
      }
      if (css.rotate !== "none") {
        const angle = css.rotate.split(/\s+/).at(-1)!;
        const degrees =
          Number.parseFloat(angle) *
          (angle.endsWith("grad")
            ? 0.9
            : angle.endsWith("rad")
              ? 180 / Math.PI
              : angle.endsWith("turn")
                ? 360
                : 1);
        transform = new DOMMatrix().rotate(degrees).multiply(transform);
      }
      const zoom = css.zoom === "normal" ? 1 : Number.parseFloat(css.zoom);
      matrix = new DOMMatrix().scale(zoom).multiply(transform).multiply(matrix);
    }
    // Translations are supplied by the painted rect, so retain only the combined linear part.
    const linear = new DOMMatrix([
      matrix.a,
      matrix.b,
      matrix.c,
      matrix.d,
      0,
      0,
    ]);
    const corners = [
      [0, 0],
      [width, 0],
      [0, height],
      [width, height],
    ].map(([x, y]) => linear.transformPoint({ x, y }));
    const rect = element.getBoundingClientRect();
    const point = linear.inverse().transformPoint({
      x: x - rect.left + Math.min(...corners.map((point) => point.x)),
      y: y - rect.top + Math.min(...corners.map((point) => point.y)),
    });
    return { x: point.x, y: point.y, width, height };
  };
  const paintsAt = (
    element: Element,
    x: number,
    y: number,
    styleOf: (element: Element) => CSSStyleDeclaration,
  ) => {
    if (!element.checkVisibility({ checkOpacity: true })) return false;
    if (
      element instanceof HTMLImageElement ||
      element instanceof HTMLVideoElement ||
      element instanceof HTMLCanvasElement ||
      element instanceof HTMLInputElement ||
      element instanceof HTMLButtonElement ||
      (element instanceof SVGElement && !(element instanceof SVGSVGElement))
    )
      return true;
    for (const pseudo of [undefined, "::before", "::after"]) {
      const style = pseudo
        ? getComputedStyle(element, pseudo)
        : styleOf(element);
      if (pseudo && (style.content === "none" || style.content === "normal"))
        continue;
      if (
        style.backgroundImage !== "none" ||
        !/^(?:transparent|rgba\(.+,\s*0\)|.+\/\s*0\))$/.test(
          style.backgroundColor,
        )
      )
        return true;
      // A transparent box can still paint its border. Its empty centre stays click-through.
      if (!pseudo) {
        const borders = ["left", "right", "top", "bottom"].flatMap((side) => {
          const width = Number.parseFloat(
            style.getPropertyValue(`border-${side}-width`),
          );
          return width > 0 &&
            !["none", "hidden"].includes(
              style.getPropertyValue(`border-${side}-style`),
            ) &&
            !/^(?:transparent|rgba\(.+,\s*0\)|.+\/\s*0\))$/.test(
              style.getPropertyValue(`border-${side}-color`),
            )
            ? [{ side, width }]
            : [];
        });
        if (borders.length) {
          const point = localPoint(element, x, y, styleOf);
          if (
            point.x >= 0 &&
            point.x <= point.width &&
            point.y >= 0 &&
            point.y <= point.height
          )
            for (const { side, width } of borders) {
              const distance =
                side === "left"
                  ? point.x
                  : side === "right"
                    ? point.width - point.x
                    : side === "top"
                      ? point.y
                      : point.height - point.y;
              if (distance <= width) return true;
            }
        }
      }
    }
    const range = document.createRange();
    for (const node of element.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.nodeValue?.trim()) continue;
      range.selectNodeContents(node);
      for (const rect of range.getClientRects())
        if (
          x >= rect.left &&
          x < rect.right &&
          y >= rect.top &&
          y < rect.bottom
        )
          return true;
    }
    return false;
  };
  /**
   * The clips under a point, topmost first, as the timeline names them: the outermost timed
   * element inside the root. `painted` is false where only a clip's empty box covers the point.
   */
  const clipsAt = (x: number, y: number) => {
    const root = document.querySelector("[data-composition-id]");
    const hits = new Map<Element, boolean>();
    const styles = new Map<Element, CSSStyleDeclaration>();
    const styleOf = (element: Element) => {
      let style = styles.get(element);
      if (!style) {
        style = getComputedStyle(element);
        styles.set(element, style);
      }
      return style;
    };
    // Only the editor requests hits. Restore authored styles synchronously, before any
    // composition script, observer, paint or capture can see a different pointer-events value.
    const overrides: {
      element: HTMLElement | SVGElement;
      style: string | null;
    }[] = [];
    try {
      // Most timeline clips are display:none. Only inspect styles on the visible tree, and
      // override only elements whose authored pointer-events would hide them from the hit test.
      // This avoids invalidating styles on all 500 clips twice for every press.
      for (const element of root?.querySelectorAll("*") ?? []) {
        if (
          !(element instanceof HTMLElement || element instanceof SVGElement) ||
          !element.checkVisibility({ checkVisibilityCSS: true }) ||
          styleOf(element).pointerEvents !== "none"
        )
          continue;
        overrides.push({
          element,
          style: element.getAttribute("style"),
        });
      }
      for (const { element } of overrides)
        element.style.setProperty("pointer-events", "auto", "important");
      for (const element of document.elementsFromPoint(x, y)) {
        if (!root?.contains(element) || element === root) continue;
        if (element.hasAttribute("data-cutroom-edit-frame")) continue;
        const source = element.hasAttribute("data-cutroom-video-hold")
          ? element.previousElementSibling
          : element;
        const clip = source?.closest("[data-hf-cutroom-clip-id]");
        if (!clip) continue;
        hits.set(clip, hits.get(clip) || paintsAt(element, x, y, styleOf));
      }
      return [...hits].flatMap(([clip, painted]) => {
        const box = boxOf(clip);
        return box
          ? [
              {
                clipId: clip.getAttribute("data-hf-cutroom-clip-id")!,
                painted,
                box,
              },
            ]
          : [];
      });
    } finally {
      for (const { element, style } of overrides)
        if (style === null) element.removeAttribute("style");
        else element.setAttribute("style", style);
    }
  };
  let metering = false;
  let stripMetering = false;
  let animation = 0;
  /** A group's mixer strip: `track:<index>` for a Cutroom track bus, `bus:<id>` for a bus. */
  const stripOf = (id: string) => {
    const group = document.getElementById(id);
    if (group?.tagName.toLowerCase() !== "hf-audio-group") return null;
    const track = group.getAttribute("data-cutroom-track");
    return track === null ? `bus:${id}` : `track:${track}`;
  };
  const levels = () => {
    if (!metering) return;
    const meter = win.__hf?.audioMeter;
    meter?.start();
    const read = win.__player?.isPlaying() ? meter?.read() : null;
    const level = read?.master;
    let details;
    if (stripMetering && meter && read) {
      const strips: Record<string, { l: number; r: number }> = {};
      for (const [id, group] of Object.entries(read.groups)) {
        const strip = stripOf(id);
        if (strip) strips[strip] = group;
      }
      // A track's clips that play through buses still show on the track's strip.
      for (const [track, level] of Object.entries(meter.pre())) {
        const shown = strips[`track:${track}`];
        strips[`track:${track}`] = shown
          ? { l: Math.max(shown.l, level.l), r: Math.max(shown.r, level.r) }
          : level;
      }
      const automated = [
        ...document.querySelectorAll(
          "hf-audio-group[data-automation]:not([data-cutroom-track])",
        ),
      ].map((group) => group.id);
      details = {
        strips,
        ...(automated.length && { faders: meter.faders(automated) }),
      };
    }
    if (win.__player?.isPlaying())
      parent.postMessage(
        {
          source: "cutroom-preview",
          type: "clock",
          time: win.__player.getTime(),
          at: performance.timeOrigin + performance.now(),
        },
        "*",
      );
    parent.postMessage(
      {
        source: "cutroom-preview",
        type: "levels",
        playing: Boolean(win.__player?.isPlaying()),
        l: level?.l ?? 0,
        r: level?.r ?? 0,
        ...details,
      },
      "*",
    );
    if (win.__player?.isPlaying()) animation = requestAnimationFrame(levels);
    else {
      animation = 0;
      meter?.stop();
    }
  };
  const state = () => {
    const root = document.querySelector("[data-composition-id]");
    const size = (name: string, fallback: number) => {
      const value = Number(root?.getAttribute(name));
      return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    return {
      rampPending,
      rampPrepared: rampFiles.size > 0,
      mixSignature:
        document
          .querySelector('meta[name="cutroom-mix-signature"]')
          ?.getAttribute("content") ?? undefined,
      ready: Boolean(win.__player),
      root: Boolean(root),
      error: win.__hfStartupError
        ? (win.__cutroomReadDiagnostics?.() ?? [])
            .map(({ file, message }) => `${file}: ${message}`)
            .join("\n") || String(win.__hfStartupError)
        : null,
      width: size("data-width", 1920),
      height: size("data-height", 1080),
      fps: root?.getAttribute("data-fps") ?? null,
      time: Number(win.__player?.getTime() ?? 0),
      playing: Boolean(win.__player?.isPlaying()),
    };
  };
  /** Every clip drawn on the picture, with its box: what a dragged clip can snap to. */
  const shownClips = () =>
    [...document.querySelectorAll("[data-hf-cutroom-clip-id]")].flatMap(
      (element) => {
        const box = boxOf(element, true);
        return box
          ? [{ clipId: element.getAttribute("data-hf-cutroom-clip-id")!, box }]
          : [];
      },
    );
  const reply = (
    id?: string,
    error?: string,
    {
      hits,
      boxes,
      mixApplied,
    }: {
      hits?: ReturnType<typeof clipsAt>;
      boxes?: ReturnType<typeof shownClips>;
      mixApplied?: boolean;
    } = {},
  ) => {
    const diagnostics = win.__cutroomReadDiagnostics?.();
    parent.postMessage(
      {
        source: "cutroom-preview",
        id,
        state: state(),
        ...(timingRevision ? { timingRevision } : {}),
        error,
        hits,
        boxes,
        mixApplied,
        ...(diagnostics?.length ? { diagnostics } : {}),
      },
      "*",
    );
  };
  const paint = () =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  const holds = new Map<
    HTMLVideoElement,
    {
      canvas: HTMLCanvasElement;
      frame: VideoFrame;
      display: string;
      callback?: number;
      timer?: number;
    }
  >();
  /** Videos a live update added, hidden until their first frame is held or they play. */
  const pendingVideos = new Set<HTMLVideoElement>();
  const FRAME_TIMEOUT = 8_000;
  /** How long a moving playhead must rest before the sources decode its exact frame. */
  const SCRUB_REST_MS = 60;
  let retired = false;
  let pictureVersion = 0;
  const frameStatus = (error: string | null) =>
    parent.postMessage(
      { source: "cutroom-preview", type: "frame-status", error },
      "*",
    );
  const reportFrameFailure = (error: unknown) =>
    frameStatus(error instanceof Error ? error.message : String(error));
  /** The picture version whose source frames, rather than scrub proxies, are on screen. */
  let exactVersion = -1;
  let picture = Promise.resolve();
  let editCanvas: HTMLCanvasElement | null = null;
  let editFrames: VideoFrame[] = [];
  const editPreloads = new Map<HTMLVideoElement, string | null>();
  const clearEditPicture = () => {
    editCanvas?.remove();
    editCanvas = null;
    for (const frame of editFrames) frame.close();
    editFrames = [];
    for (const [video, preload] of editPreloads) {
      if (preload === null) video.removeAttribute("preload");
      else video.setAttribute("preload", preload);
    }
    editPreloads.clear();
  };
  /** Seeks the edges' sources together and captures their frames, or null when superseded. */
  const captureEdges = async (
    edges: EditFrame[],
    version: number,
    deadline: number,
  ): Promise<(VideoFrame | HTMLImageElement)[] | null> => {
    const sources = await Promise.all(
      edges.map(async (edge) => {
        const element = clipElement(edge.clipId);
        if (!(
          element instanceof HTMLVideoElement ||
          element instanceof HTMLImageElement
        ))
          throw new Error(
            `The preview cannot show the edit frame for ${edge.clipId}.`,
          );
        if (element instanceof HTMLVideoElement) {
          element.pause();
          if (!editPreloads.has(element))
            editPreloads.set(element, element.getAttribute("preload"));
          element.preload = "auto";
          if (!element.readyState) element.load();
          while (!element.readyState) {
            if (retired || version !== pictureVersion) return element;
            if (element.error) throw new Error(element.error.message);
            if (performance.now() > deadline)
              throw new Error(
                "The preview did not load the edit source in time.",
              );
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            );
          }
          // With the runtime's media-element lead, at the place export's frame shows.
          await loadGrid(element);
          element.currentTime = edge.time + 0.00001;
        }
        return element;
      }),
    );
    const frames: (VideoFrame | HTMLImageElement)[] = [];
    for (;;) {
      if (retired || version !== pictureVersion) return null;
      if (performance.now() > deadline)
        throw new Error("The preview did not draw the edit frame in time.");
      if (
        sources.some((source) =>
          source instanceof HTMLVideoElement
            ? source.seeking || source.readyState < 2
            : !source.complete || !source.naturalWidth,
        )
      ) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        continue;
      }
      try {
        for (const source of sources)
          frames.push(
            source instanceof HTMLVideoElement
              ? new VideoFrame(source)
              : source,
          );
        break;
      } catch (error) {
        for (const frame of frames)
          if (frame instanceof VideoFrame) frame.close();
        frames.length = 0;
        if (!(
          error instanceof DOMException && error.name === "InvalidStateError"
        ))
          throw error;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      }
    }
    return frames;
  };

  const showEditPicture = async (edges: EditFrame[], version: number) => {
    // Reuse the document's source elements, even beyond their saved trim windows.
    // The runtime is paused; its normal seek restores all media on release.
    await win.__hfWaitForSeekCompletion?.();
    const deadline = performance.now() + FRAME_TIMEOUT;
    // One element shows one frame at a time, so a slip's in and out of the same clip are
    // decoded in turn; different clips still seek together.
    const rounds: EditFrame[][] = [];
    for (const edge of edges) {
      const round = rounds.find(
        (each) => !each.some((other) => other.clipId === edge.clipId),
      );
      if (round) round.push(edge);
      else rounds.push([edge]);
    }
    const frames: (VideoFrame | HTMLImageElement)[] = [];
    try {
      for (const round of rounds) {
        const captured = await captureEdges(round, version, deadline);
        if (!captured) return;
        // Put each frame back in the order the edges asked for.
        for (const [index, frame] of captured.entries())
          frames[edges.indexOf(round[index]!)] = frame;
      }
      const { width, height } = state();
      const canvas = editCanvas ?? document.createElement("canvas");
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      canvas.dataset.cutroomEditFrame = "";
      canvas.dataset.count = String(frames.length);
      canvas.style.cssText =
        "position:fixed;inset:0;width:100%;height:100%;z-index:2147483647;pointer-events:none";
      const context = canvas.getContext("2d");
      if (!context)
        throw new Error("The preview could not hold the edit frame.");
      context.fillRect(0, 0, width, height);
      frames.forEach((frame, index) => {
        const w =
          frame instanceof VideoFrame ? frame.displayWidth : frame.naturalWidth;
        const h =
          frame instanceof VideoFrame
            ? frame.displayHeight
            : frame.naturalHeight;
        const panel = width / frames.length;
        const scale = Math.min(panel / w, height / h);
        context.drawImage(
          frame,
          index * panel + (panel - w * scale) / 2,
          (height - h * scale) / 2,
          w * scale,
          h * scale,
        );
      });
      if (!editCanvas) document.body.append(canvas);
      editCanvas = canvas;
      for (const frame of editFrames) frame.close();
      editFrames = frames.filter(
        (frame): frame is VideoFrame => frame instanceof VideoFrame,
      );
      frames.length = 0;
      frameStatus(null);
    } finally {
      for (const frame of frames)
        if (frame instanceof VideoFrame) frame.close();
    }
  };
  // Footage pipeline: the parent draws the root videos it names beneath this document. Those
  // videos stay in the DOM the runtime and the live-update checks compare, but never load: their
  // media properties answer as a ready, seeked element. A constructed sheet, outside the DOM, hides
  // them and clears the page's background so the parent's picture shows through. Every other
  // video plays and draws here as usual, on top.
  const ROOT_COMPOSITION =
    "[data-composition-id]:not([data-composition-id] [data-composition-id])";
  const pipelineSheet = new CSSStyleSheet();
  let pipelineActive = false;
  let pipelineDrawn = new Set<string>();
  /** A video's timeline id: its id, or HyperFrames' own when it has none. */
  const clipId = (media: HTMLMediaElement) =>
    media.getAttribute("id") ?? media.getAttribute("data-hf-id");
  const drawnByPipeline = (media: HTMLMediaElement) =>
    pipelineDrawn.has(clipId(media) ?? "");
  const writePipelineSheet = () => {
    // Ids reach the selector escaped, as CSS strings.
    const drawn = [...pipelineDrawn].flatMap((id) => [
      `[id="${CSS.escape(id)}"]`,
      `:not([id])[data-hf-id="${CSS.escape(id)}"]`,
    ]);
    // A frame whose document's colour scheme differs from the dark editor's gets an opaque white
    // backdrop. The scheme only picks system colours, so the default text colour stays black.
    pipelineSheet.replaceSync(
      ":root { color-scheme: dark !important; } :where(:root) { color: #000; }" +
        `html, body, ${ROOT_COMPOSITION} { background: transparent !important; }` +
        (drawn.length
          ? `${ROOT_COMPOSITION} > video:is(${drawn.join(", ")}) { opacity: 0 !important; }`
          : ""),
    );
  };
  /** Parked media, and whether parking released media the element had loaded. */
  const parked = new Map<HTMLMediaElement, { released: boolean }>();
  win.__cutroomParkedMedia = parked;
  // Chromium can report HAVE_ENOUGH_DATA even for a WAV with no PCM payload.
  const invalidRamp = (audio: HTMLAudioElement, duration: number) =>
    audio.error !== null ||
    (audio.readyState >= HTMLMediaElement.HAVE_METADATA &&
      (!Number.isFinite(audio.duration) ||
        Math.abs(audio.duration - duration) > 0.00005));
  let rampFailed = false;
  const watchRamp = (audio: EventTarget | null) => {
    if (
      retired ||
      rampFailed ||
      !(audio instanceof HTMLAudioElement) ||
      parked.has(audio)
    )
      return;
    const duration = rampFiles.get(audio.getAttribute("src") ?? "");
    if (duration !== undefined && invalidRamp(audio, duration)) {
      rampFailed = true;
      parent.postMessage(
        { source: "cutroom-preview", type: "ramp-audio-failed" },
        "*",
      );
    }
  };
  if (rampFiles.size) {
    const inspectRamp = (event: Event) => watchRamp(event.target);
    document.addEventListener("loadedmetadata", inspectRamp, true);
    document.addEventListener("durationchange", inspectRamp, true);
    document.addEventListener("error", inspectRamp, true);
  }
  const loadRamp = (
    audio: HTMLAudioElement,
    duration: number,
    signal: AbortSignal,
  ) =>
    new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const events = [
        "loadedmetadata",
        "loadeddata",
        "progress",
        "canplay",
        "error",
      ];
      const finish = (error?: Error) => {
        for (const name of events) audio.removeEventListener(name, inspect);
        signal.removeEventListener("abort", timeout);
        if (error) reject(error);
        else resolve();
      };
      const failure = () =>
        new Error("Prepared ramp audio could not be loaded.");
      const timeout = () => finish(failure());
      const inspect = () => {
        if (parked.has(audio) || invalidRamp(audio, duration))
          finish(failure());
        else if (
          audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          audio.buffered.length > 0
        )
          finish();
      };
      for (const name of events) audio.addEventListener(name, inspect);
      signal.addEventListener("abort", timeout, { once: true });
      audio.preload = "auto";
      inspect();
    });
  const PARKED = [
    "currentTime",
    "readyState",
    "networkState",
    "seeking",
    "paused",
    "preload",
    "play",
    "pause",
    "load",
  ];
  const park = (media: HTMLMediaElement) => {
    if (parked.has(media)) return;
    if (media instanceof HTMLVideoElement) deferredSeeks.delete(media);
    // While "playing", the time runs on like a real element's, so the runtime sees no drift.
    let time = mediaTime.get.call(media);
    let paused = true;
    let playedAt = 0;
    const now = () =>
      paused
        ? time
        : time + ((performance.now() - playedAt) / 1000) * media.playbackRate;
    // An element that already loaded gives its media back; its src stays in the DOM.
    const released = media.readyState > HTMLMediaElement.HAVE_NOTHING;
    if (released) {
      media.pause();
      media.srcObject = new MediaStream();
    }
    parked.set(media, { released });
    if (media instanceof HTMLVideoElement) {
      if (holds.has(media)) removeHold(media);
      const grading = win.__hf?.colorGrading;
      if (grading?.isGraded(media)) grading.setGrading(media, null);
    }
    const value = (get: () => unknown) => ({ configurable: true, get });
    Object.defineProperties(media, {
      currentTime: {
        configurable: true,
        get: now,
        set: (next: number) => {
          time = next;
          playedAt = performance.now();
        },
      },
      readyState: value(() => HTMLMediaElement.HAVE_ENOUGH_DATA),
      networkState: value(() => HTMLMediaElement.NETWORK_IDLE),
      seeking: value(() => false),
      paused: value(() => paused),
      preload: { configurable: true, get: () => "none", set: () => {} },
      play: {
        configurable: true,
        value: () => {
          if (paused) {
            paused = false;
            playedAt = performance.now();
          }
          return Promise.resolve();
        },
      },
      pause: {
        configurable: true,
        value: () => {
          time = now();
          paused = true;
        },
      },
      load: { configurable: true, value: () => {} },
    });
  };
  const unpark = (media: HTMLMediaElement, load: boolean) => {
    const entry = parked.get(media);
    if (!entry) return;
    parked.delete(media);
    for (const name of PARKED) Reflect.deleteProperty(media, name);
    if (entry.released) media.srcObject = null;
    // Load where the runtime will want it, its media start for a clip still to come, so the
    // cut never waits for a seek.
    if (load) {
      media.preload = "auto";
      const time = expectedMediaTime(media);
      if (time !== null) mediaTime.set.call(media, time);
    }
    if (rampFiles.size) watchRamp(media);
  };
  const rootMedia = (kind: "video" | "audio") =>
    document.querySelectorAll<HTMLMediaElement>(
      `${ROOT_COMPOSITION} > ${kind}`,
    );
  /** Sound near the playhead stays loaded; the rest waits until the playhead comes near. */
  const AUDIO_BEHIND = 2;
  const AUDIO_AHEAD = 8;
  const residentAudio = (moving: boolean) => {
    if (!pipelineActive) return;
    const time = win.__player?.getTime() ?? 0;
    for (const audio of rootMedia("audio")) {
      const clip = win.__hf?.clipWindow?.(audio);
      const near =
        !clip ||
        (clip.end > time - AUDIO_BEHIND && clip.start < time + AUDIO_AHEAD);
      if (!near) park(audio);
      // A moving playhead loads nothing new; it rests or plays soon enough.
      else if (!moving) unpark(audio, true);
    }
  };
  let residency = 0;
  // The runtime may replace one video in place when a source edit changes its grade, even
  // though the plan still names the same clip. Park the replacement and release the old entry.
  const pipelineMedia = new MutationObserver((records) => {
    for (const { addedNodes, removedNodes } of records) {
      for (const node of removedNodes)
        if (node instanceof HTMLVideoElement && !node.isConnected)
          unpark(node, false);
      for (const node of addedNodes)
        if (
          node instanceof HTMLVideoElement &&
          node.isConnected &&
          drawnByPipeline(node)
        )
          park(node);
    }
  });
  /** Parks the videos the pipeline draws and gives back the rest; true when one comes back. */
  const parkRootVideos = () => {
    if (!pipelineActive) return false;
    let released = false;
    for (const video of rootMedia("video"))
      if (drawnByPipeline(video)) park(video);
      else if (parked.has(video)) {
        unpark(video, false);
        released = true;
      }
    return released;
  };
  /** True when media comes back, so the runtime must seek again for it to load and draw. */
  const setPipeline = (active: boolean, drawn: Set<string>) => {
    pipelineActive = active;
    pipelineDrawn = drawn;
    writePipelineSheet();
    const sheets = document.adoptedStyleSheets.filter(
      (sheet) => sheet !== pipelineSheet,
    );
    document.adoptedStyleSheets = active ? [...sheets, pipelineSheet] : sheets;
    clearInterval(residency);
    pipelineMedia.disconnect();
    if (active) {
      const root = document.querySelector(ROOT_COMPOSITION);
      if (root) pipelineMedia.observe(root, { childList: true });
      const released = parkRootVideos();
      if (document.querySelector(`video[${GRADE_ATTRIBUTE}]`)) {
        win.__hf?.colorGrading?.refresh();
        if (released && gradeBypass) writeGradeBypass();
      }
      residentAudio(false);
      return released;
    }
    const released = parked.size > 0;
    for (const media of [...parked.keys()]) unpark(media, false);
    if (released && document.querySelector(`video[${GRADE_ATTRIBUTE}]`)) {
      win.__hf?.colorGrading?.refresh();
      if (gradeBypass) writeGradeBypass();
    }
    return released;
  };
  const holdStyle = document.createElement("style");
  holdStyle.textContent =
    "video[data-cutroom-held] { visibility: hidden !important; }" +
    "video[data-cutroom-held][data-cutroom-flow] { position: absolute !important; }" +
    // While a video seeks, the runtime shows a still copy and sets the video to display:none,
    // which cancels its transition animations. Its CSS adapter keeps their handles and its next
    // pause revives them beside the new ones, so each hold composes the fade once more. Hidden
    // in place, the video keeps its one animation per edge.
    "video[data-hf-seek-video]:is([data-transition-in], [data-transition-out]) { display: block !important; visibility: hidden !important; }";
  document.head.append(holdStyle);
  const cancelRelease = (video: HTMLVideoElement) => {
    const hold = holds.get(video);
    if (!hold) return;
    if (hold.callback !== undefined)
      video.cancelVideoFrameCallback(hold.callback);
    clearTimeout(hold.timer);
    delete hold.callback;
    delete hold.timer;
  };
  const removeHold = (video: HTMLVideoElement) => {
    cancelRelease(video);
    const hold = holds.get(video);
    hold?.canvas.remove();
    hold?.frame.close();
    holds.delete(video);
    video.removeAttribute("data-cutroom-held");
    video.removeAttribute("data-cutroom-flow");
  };
  const captureFrames = (
    videos: HTMLVideoElement[],
    samples: Map<HTMLVideoElement, ProxySample>,
  ) => {
    const frames = new Map<HTMLVideoElement, VideoFrame>();
    try {
      for (const video of videos) {
        const frame = new VideoFrame(video);
        frames.set(video, frame);
        // Chromium can settle its seek clock while both APIs still carry the old picture.
        const sample = samples.get(video);
        const decoded = decodedSeeks.get(video);
        const presented = decoded?.timestamp;
        const confirmed = sample ? decoded?.confirmed : undefined;
        if (
          (sample && Math.abs(frame.timestamp - sample.start * 1e6) > 2) ||
          (decoded &&
            !(
              presented !== undefined &&
              Math.abs(frame.timestamp - presented) <= 1
            ) &&
            !(
              confirmed !== undefined &&
              Math.abs(frame.timestamp - confirmed) <= 1
            ))
        ) {
          for (const frame of frames.values()) frame.close();
          return null;
        }
      }
      for (const video of videos) {
        const decoded = decodedSeeks.get(video);
        if (decoded) decoded.confirmed = frames.get(video)!.timestamp;
        if (decoded?.callback !== undefined) {
          cancelVideoFrame.call(video, decoded.callback);
          delete decoded.callback;
        }
      }
      return frames;
    } catch (error) {
      for (const frame of frames.values()) frame.close();
      if (error instanceof DOMException && error.name === "InvalidStateError")
        return null;
      throw error;
    }
  };
  /** Draws `frame` in place of `video`; the hold then owns the frame. */
  const showHold = (
    video: HTMLVideoElement,
    frame: VideoFrame,
    proxy: boolean,
  ) => {
    // The pipeline can take ownership while a native seek is waiting for a decoded frame.
    if (parked.has(video)) {
      frame.close();
      return;
    }
    cancelRelease(video);
    const previous = holds.get(video);
    video.removeAttribute("data-cutroom-held");
    try {
      const style = getComputedStyle(video);
      const canvas = previous?.canvas ?? document.createElement("canvas");
      canvas.setAttribute("data-cutroom-video-hold", "");
      const positioned =
        style.position === "absolute" || style.position === "fixed";
      const fixed: Record<string, string> = {
        "pointer-events": "none",
        ...(positioned ? { right: "auto", bottom: "auto" } : {}),
      };
      // Writing only what changed keeps a scrub's redraws free of style invalidation.
      for (const name of style) {
        if (/^(animation|transition)/.test(name)) continue;
        const value = fixed[name] ?? style.getPropertyValue(name);
        if (canvas.style.getPropertyValue(name) !== value)
          canvas.style.setProperty(name, value);
      }
      if (canvas.style.animation !== "none") canvas.style.animation = "none";
      if (canvas.style.transition !== "none") canvas.style.transition = "none";
      // Keep the source aspect ratio so the browser applies object-fit and
      // object-position exactly as it does to the replaced video element.
      let a = video.videoWidth;
      let b = video.videoHeight;
      while (b) [a, b] = [b, a % b];
      const unitWidth = video.videoWidth / a;
      const unitHeight = video.videoHeight / a;
      const scale = Math.min(
        a,
        Math.max(
          1,
          Math.ceil(
            devicePixelRatio *
              Math.max(
                video.clientWidth / unitWidth,
                video.clientHeight / unitHeight,
              ),
          ),
        ),
      );
      // Where object-fit ignores intrinsic size, a proxy frame keeps its own size and
      // the compositor scales it like the source.
      const own =
        proxy && ["fill", "contain", "cover"].includes(style.objectFit);
      const width = own
        ? frame.displayWidth
        : style.objectFit === "none"
          ? video.videoWidth
          : unitWidth * scale;
      const height = own
        ? frame.displayHeight
        : style.objectFit === "none"
          ? video.videoHeight
          : unitHeight * scale;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      // The canvas takes the video's place in flow, including flex/grid
      // layout and paint order. The hidden native video keeps decoding.
      if (!positioned) video.setAttribute("data-cutroom-flow", "");
      const context = canvas.getContext("2d");
      if (!context)
        throw new Error("The preview could not hold the video frame.");
      if (!proxy) context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(frame, 0, 0, canvas.width, canvas.height);
      if (video.nextElementSibling !== canvas) video.after(canvas);
      previous?.frame.close();
      holds.set(video, {
        canvas,
        frame,
        display: canvas.style.display,
      });
      canvas.toggleAttribute("data-cutroom-proxy", proxy);
    } finally {
      const hold = holds.get(video);
      if (hold) {
        video.setAttribute("data-cutroom-held", "");
        hold.canvas.style.setProperty("display", hold.display);
      }
    }
  };
  /** Videos the composition shows, read without this bridge's suppression. */
  /**
   * A video in a codec this browser cannot decode, such as HEVC or ProRes, until HyperFrames'
   * runtime swaps in the editing proxy the server is making. Until then it plays only its sound,
   * or fails to load, and has no picture to wait for.
   */
  const awaitingProxy = (video: HTMLVideoElement) => {
    if (!video.error && (!video.readyState || video.videoWidth)) return false;
    const path = decodeURIComponent(
      new URL(video.currentSrc || video.src, location.href).pathname,
    );
    return Object.entries(win.__HF_MEDIA_CODEC_MAP__ ?? {}).some(
      ([media, facts]) => facts.browserHostile && path.endsWith(media),
    );
  };
  const visibleVideos = () => {
    const hidden = new Set([
      ...holds.keys(),
      ...deferredSeeks.keys(),
      ...pendingVideos,
    ]);
    for (const video of hidden) video.removeAttribute("data-cutroom-held");
    const videos = Array.from(document.querySelectorAll("video")).filter(
      (video) =>
        video.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
        }) && !awaitingProxy(video),
    );
    for (const video of hidden) video.setAttribute("data-cutroom-held", "");
    return videos;
  };
  /**
   * Where the runtime places a constant-rate video's media at the playhead, from its own
   * resolved clip window. Null when it cannot be known here, such as for speed ramps.
   */
  const expectedMediaTime = (video: HTMLMediaElement) => {
    const clip = win.__hf?.clipWindow?.(video);
    const time = win.__player?.getTime();
    const automation = video.getAttribute("data-automation");
    // The runtime's root: the composition marked as root, or else the first one.
    const marked = document.querySelector(
      '[data-composition-id][data-root="true"]',
    );
    const root =
      marked instanceof HTMLElement
        ? marked
        : document.querySelector("[data-composition-id]");
    // Only the root composition's clips are timed against the player's clock.
    if (
      !clip ||
      time === undefined ||
      video.closest("[data-composition-id]") !== root ||
      video.loop ||
      (automation !== null && /"target"\s*:\s*"(?!volume")/.test(automation))
    )
      return null;
    // Read exactly as the runtime reads them: an offset is a whole non-negative number,
    // the playback start before the media start; a rate is clamped to its bounds.
    const offset = (name: string) => {
      const value = video.getAttribute(name);
      if (value === null || value.trim() === "") return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : null;
    };
    const start =
      offset("data-playback-start") ?? offset("data-media-start") ?? 0;
    const authored = Number.parseFloat(
      video.getAttribute("data-playback-rate") ?? "",
    );
    const given =
      Number.isFinite(authored) && authored > 0
        ? authored
        : video.defaultPlaybackRate;
    const rate =
      Number.isFinite(given) && given > 0
        ? Math.max(minRate, Math.min(maxRate, given))
        : 1;
    const media =
      start + rate * Math.max(0, Math.min(time, clip.end) - clip.start);
    return Number.isFinite(video.duration)
      ? Math.min(media, video.duration)
      : media;
  };
  const holdPaused = async (version: number, shouldHold = () => true) => {
    const current = () =>
      version === pictureVersion && !win.__player?.isPlaying() && shouldHold();
    if (!current()) return;
    const waitForSeek = win.__hfWaitForSeekCompletion;
    if (typeof waitForSeek !== "function")
      throw new Error("The preview cannot confirm that it drew the frame.");
    let timer = 0;
    const corrected = new Set<HTMLVideoElement>();
    try {
      await Promise.race([
        (async () => {
          await waitForSeek();
          for (;;) {
            if (!current()) return;
            const videos = visibleVideos();
            const failed = videos.find((video) => video.error);
            if (failed)
              throw new Error(
                `The preview could not load ${failed.getAttribute("src")}.`,
              );
            if (videos.some((video) => video.readyState < 2 || video.seeking)) {
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve()),
              );
              continue;
            }
            // Frames are placed by each source's grid, which a new source reads first.
            await Promise.all(videos.map(loadGrid));
            if (!current()) return;
            // A grid that just came moved its videos; their frames are on the way.
            if (videos.some((video) => video.seeking)) continue;
            // A video the runtime has not moved to this time would be held at its old frame,
            // for instance one that came back into view while its seek stalled, or one a step
            // of a frame moved less than the runtime's 20 ms tolerance at 50 fps and above.
            // Move it. Each video is moved at most once for this picture; if it is still off
            // once that seek has settled, the runtime's own placement stands.
            const stale = videos.flatMap((video) => {
              const time = expectedMediaTime(video);
              return time !== null &&
                !corrected.has(video) &&
                Math.abs(
                  nativeTime.get!.call(video) -
                    pausedPosition(video, time + 1e-5),
                ) > 1e-4
                ? [{ video, time }]
                : [];
            });
            if (stale.length) {
              for (const { video, time } of stale) {
                corrected.add(video);
                mediaTime.set.call(video, time + 1e-5);
              }
              const root = document.documentElement;
              root.setAttribute(
                "data-cutroom-media-corrections",
                String(
                  Number(root.getAttribute("data-cutroom-media-corrections")) +
                    stale.length,
                ),
              );
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve()),
              );
              continue;
            }
            // A native element can paint nothing despite reporting HAVE_CURRENT_DATA.
            // Acquire every decoded frame before replacing any displayed picture.
            const samples = new Map<HTMLVideoElement, ProxySample>();
            await Promise.all(
              videos.map(async (video) => {
                const sample = await proxySampleAt(
                  video,
                  framePosition(video, mediaTime.get.call(video)),
                );
                if (sample) samples.set(video, sample);
              }),
            );
            if (!current()) return;
            if (videos.some((video) => video.seeking)) continue;
            const frames = captureFrames(videos, samples);
            if (!frames) {
              // An editing proxy playing from its pieces has no frame to give after it loads
              // until it is sought, even to where it is. Seek each such video once.
              for (const video of videos) {
                if (corrected.has(video)) continue;
                try {
                  new VideoFrame(video).close();
                } catch {
                  corrected.add(video);
                  mediaTime.set.call(video, mediaTime.get.call(video));
                }
              }
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve()),
              );
              continue;
            }
            try {
              for (const [video] of holds) {
                if (!videos.includes(video)) removeHold(video);
              }
              for (const [video, frame] of frames) {
                showHold(video, frame, false);
                frames.delete(video);
              }
              // The runtime decides whether an added video that has no frame here shows.
              const grading = win.__hf?.colorGrading;
              let redrawGrade = false;
              for (const video of pendingVideos) {
                pendingVideos.delete(video);
                if (holds.has(video)) continue;
                video.removeAttribute("data-cutroom-held");
                redrawGrade ||= grading?.isGraded(video) ?? false;
              }
              // A canvas can inherit the temporary hidden state while its video loads.
              // A paused source has no next frame to update the canvas's visibility.
              if (redrawGrade) grading?.redraw();
              exactVersion = version;
              frameStatus(null);
            } finally {
              for (const frame of frames.values()) frame.close();
            }
            return;
          }
        })(),
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(
            () =>
              reject(new Error("The preview did not draw the frame in time.")),
            FRAME_TIMEOUT,
          );
        }),
      ]);
    } catch (error) {
      if (!current()) return;
      pictureVersion += 1;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  // Scrub proxies: a small all-intra copy of each source, whose frames a moving playhead
  // draws until the source decodes the exact frame. Paths are the project's, as the media
  // service names them; the capability prefix is this document's.
  const capability = /^\/api\/isolated\/[^/]+\//.exec(location.pathname)?.[0];
  const scrubSources = new Map<
    string,
    { key?: string; failed?: boolean; proxy?: HTMLVideoElement; used: number }
  >();
  const scrubPath = (video: HTMLVideoElement) => {
    if (!capability) return null;
    const url = new URL(video.currentSrc || video.src, location.href);
    const preview = `${capability}preview/`;
    if (url.origin !== location.origin || !url.pathname.startsWith(preview))
      return null;
    const path = url.pathname.slice(preview.length);
    if (!path || path.startsWith("comp/")) return null;
    try {
      return path.split("/").map(decodeURIComponent).join("/");
    } catch {
      return null;
    }
  };
  let discovering = false;
  /** Asks for every source's proxy, which also starts making the missing ones. */
  const discoverScrubs = () => {
    if (discovering || !capability) return;
    discovering = true;
    void (async () => {
      try {
        for (let pending = true; pending && !retired;) {
          pending = false;
          for (const video of document.querySelectorAll("video")) {
            const path = scrubPath(video);
            if (!path) continue;
            const source = scrubSources.get(path) ?? { used: 0 };
            scrubSources.set(path, source);
            if (source.key || source.failed) continue;
            const response = await fetch(
              `${capability}scrub?path=${encodeURIComponent(path)}`,
            ).catch(() => null);
            const body: unknown =
              response?.status === 200 ? await response.json() : null;
            if (
              body &&
              typeof body === "object" &&
              "key" in body &&
              typeof body.key === "string" &&
              /^[a-f0-9]{64}$/.test(body.key)
            )
              source.key = body.key;
            else if (response?.status === 202) pending = true;
            else source.failed = true;
          }
          if (pending)
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      } finally {
        discovering = false;
      }
    })();
  };
  const releaseProxy = (source: { proxy?: HTMLVideoElement }) => {
    source.proxy?.removeAttribute("src");
    source.proxy?.load();
    delete source.proxy;
  };
  /** A loaded proxy for a source, or null when it is unknown, missing or slow to load. */
  const proxyFor = async (video: HTMLVideoElement) => {
    const path = scrubPath(video);
    const source = path ? scrubSources.get(path) : undefined;
    if (path && !source) discoverScrubs();
    if (!source?.key) return null;
    source.used = performance.now();
    if (source.proxy?.error) {
      releaseProxy(source);
      source.failed = true;
      delete source.key;
      return null;
    }
    if (!source.proxy) {
      const proxy = document.createElement("video");
      // CORS keeps the opaque document allowed to read its frames.
      proxy.crossOrigin = "anonymous";
      proxy.muted = true;
      proxy.preload = "auto";
      proxy.src = `${capability}scrub/${source.key}`;
      source.proxy = proxy;
      // Each element holds a decoder; keep the four most recently drawn.
      const loaded = [...scrubSources.values()]
        .filter((other) => other.proxy)
        .sort((a, b) => b.used - a.used);
      for (const other of loaded.slice(4)) releaseProxy(other);
    }
    const proxy = source.proxy;
    // A new document's first scrub waits briefly rather than seeking a source cold.
    const deadline = performance.now() + 250;
    while (proxy.readyState < 2 && !proxy.error && performance.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    return proxy.readyState >= 2 ? proxy : null;
  };
  /** Each source's frame grid, by project path, once the server has read it. */
  const grids = new Map<string, Promise<FrameGrid>>();
  const known = new Map<string, FrameGrid>();
  /** Reads a video's frame grid once; null when it has none or the server cannot read it. */
  const loadGrid = (video: HTMLVideoElement) => {
    const path = scrubPath(video);
    if (!path) return Promise.resolve(null);
    let grid = grids.get(path);
    if (!grid) {
      grid = fetch(`${capability}frames?path=${encodeURIComponent(path)}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((body: unknown) =>
          body &&
          typeof body === "object" &&
          "start" in body &&
          typeof body.start === "number" &&
          Number.isFinite(body.start) &&
          "rate" in body &&
          typeof body.rate === "number" &&
          Number.isFinite(body.rate) &&
          body.rate > 0
            ? { start: body.start, rate: body.rate }
            : null,
        )
        .catch(() => null)
        .then((found) => {
          known.set(path, found);
          // A paused video the runtime placed before the grid came moves to export's frame.
          if (found)
            for (const video of document.querySelectorAll("video"))
              if (
                scrubPath(video) === path &&
                video.paused &&
                !asked.has(video) &&
                !parked.has(video) &&
                !deferredSeeks.has(video)
              )
                mediaTime.set.call(video, nativeTime.get!.call(video));
          return found;
        });
      grids.set(path, grid);
    }
    return grid;
  };
  /**
   * Where a paused video is put to show the frame export writes at `time`, which the runtime
   * asks for with its 10 microsecond lead. Without a grid, the time itself.
   */
  const framePosition = (media: HTMLMediaElement, time: number) => {
    const path = media instanceof HTMLVideoElement ? scrubPath(media) : null;
    const grid = path ? known.get(path) : null;
    return grid ? seekInFrame(grid, time) : time;
  };
  type ProxySample = { start: number; next?: number };
  type SamplePage = {
    path: string;
    from: number | null;
    to: number | null;
    times: number[];
  };
  const samplePages: SamplePage[] = [];
  const otherProxies = new Set<string>();
  const sampleRequests = new Map<string, Promise<SamplePage | null>>();
  const editingProxyPath = (video: HTMLVideoElement) => {
    const url = new URL(video.currentSrc || video.src, location.href);
    if (
      url.searchParams.get("hf-proxy") !== "h264" ||
      [...url.searchParams.keys()].some(
        (key) => key !== "hf-proxy" && key !== "hf-proxy-retry",
      )
    )
      return null;
    const path = scrubPath(video);
    return path && !otherProxies.has(path) ? path : null;
  };
  const cachedSamples = (path: string, at: number) =>
    samplePages.find(
      (page) =>
        page.path === path &&
        (page.from === null || at >= page.from) &&
        (page.to === null || at < page.to),
    );
  const loadSamples = (path: string, at: number) => {
    const query = new URLSearchParams({ path, at: String(at) }).toString();
    let request = sampleRequests.get(query);
    if (request) return request;
    request = (async () => {
      const response = await fetch(`${capability}proxy-samples?${query}`);
      if (response.status === 204) {
        otherProxies.add(path);
        return null;
      }
      if (!response.ok)
        throw new Error(
          "The preview could not read the editing proxy's frame times.",
        );
      const body: unknown = await response.json();
      if (
        !body ||
        typeof body !== "object" ||
        !("from" in body) ||
        !("to" in body) ||
        !(
          body.from === null ||
          (typeof body.from === "number" && Number.isFinite(body.from))
        ) ||
        !(
          body.to === null ||
          (typeof body.to === "number" && Number.isFinite(body.to))
        ) ||
        !("times" in body) ||
        !Array.isArray(body.times) ||
        !body.times.length ||
        !body.times.every(
          (time: unknown) => typeof time === "number" && Number.isFinite(time),
        )
      )
        throw new Error("The editing proxy has invalid frame times.");
      const page = { path, from: body.from, to: body.to, times: body.times };
      samplePages.push(page);
      if (samplePages.length > 8) samplePages.shift();
      return page;
    })().finally(() => sampleRequests.delete(query));
    sampleRequests.set(query, request);
    return request;
  };
  const sampleAt = (page: SamplePage, at: number): ProxySample => {
    // Every sample holds until its successor, including the last sample in a video with
    // a longer audio track. Allow for the conversion between packet ticks and microseconds.
    const index = Math.max(
      0,
      page.times.findLastIndex((time) => time <= at + 1e-6),
    );
    return { start: page.times[index]!, next: page.times[index + 1] };
  };
  const proxySampleAt = async (video: HTMLVideoElement, at: number) => {
    const path = editingProxyPath(video);
    if (!path) return null;
    const page = cachedSamples(path, at) ?? (await loadSamples(path, at));
    return page && sampleAt(page, at);
  };
  const samplePosition = (sample: ProxySample, target: number) => {
    // Stay in the first half of the interval for HLS players that seek to the nearest
    // sample. For the last sample, seek within the picture even if audio extends past it.
    const lead = Math.min(
      0.002,
      ((sample.next ?? Infinity) - sample.start) / 4,
    );
    const firstHalf =
      sample.next === undefined
        ? sample.start + lead
        : (sample.start + sample.next) / 2 - lead;
    return Math.max(sample.start + lead, Math.min(target, firstHalf));
  };
  const clampMediaTime = (media: HTMLMediaElement, target: number) =>
    Math.min(
      target,
      Number.isFinite(media.duration) ? media.duration : Infinity,
    );
  const pausedPosition = (video: HTMLVideoElement, time: number) => {
    const target = framePosition(video, time);
    const path = editingProxyPath(video);
    const page = path ? cachedSamples(path, target) : undefined;
    return clampMediaTime(
      video,
      page ? samplePosition(sampleAt(page, target), target) : target,
    );
  };
  const nativeTime = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    "currentTime",
  )!;
  // The runtime later wraps these APIs to report its cached paused pictures too.
  const requestVideoFrame =
    HTMLVideoElement.prototype.requestVideoFrameCallback;
  const cancelVideoFrame = HTMLVideoElement.prototype.cancelVideoFrameCallback;
  const decodedSeeks = new Map<
    HTMLVideoElement,
    { callback?: number; timestamp?: number; confirmed?: number }
  >();
  const forgetDecodedSeek = (video: HTMLVideoElement) => {
    const previous = decodedSeeks.get(video);
    if (previous?.callback !== undefined)
      cancelVideoFrame.call(video, previous.callback);
    decodedSeeks.delete(video);
  };
  const expectDecodedSeek = (video: HTMLVideoElement) => {
    const confirmed = decodedSeeks.get(video)?.confirmed;
    forgetDecodedSeek(video);
    const decoded: {
      callback?: number;
      timestamp?: number;
      confirmed?: number;
    } = { confirmed };
    decodedSeeks.set(video, decoded);
    const presented: VideoFrameRequestCallback = (_now, frame) => {
      if (decodedSeeks.get(video) !== decoded) return;
      decoded.timestamp = frame.mediaTime * 1e6;
      // Presentation can precede seeked. Keep observing until capture confirms the frame.
      decoded.callback = requestVideoFrame.call(video, presented);
    };
    // Register before setting currentTime so even a cached frame's presentation is observed.
    decoded.callback = requestVideoFrame.call(video, presented);
  };
  document.addEventListener(
    "emptied",
    (event) => {
      if (event.target instanceof HTMLVideoElement) {
        forgetDecodedSeek(event.target);
        asked.delete(event.target);
      }
    },
    true,
  );
  /** The time a paused video was asked for, while it rests where that time's frame shows. */
  const asked = new WeakMap<HTMLMediaElement, { time: number; at: number }>();
  const seekMedia = (media: HTMLMediaElement, time: number, at: number) => {
    const entry = { time, at };
    asked.set(media, entry);
    if (
      media instanceof HTMLVideoElement &&
      media.paused &&
      Math.abs(nativeTime.get!.call(media) - at) > 1e-6
    )
      expectDecodedSeek(media);
    nativeTime.set!.call(media, at);
    return entry;
  };
  /**
   * Every video's `currentTime`: a paused seek goes to where export's frame shows, and reads
   * back as the time asked for until the video moves, so the runtime sees its own time.
   */
  const mediaTime = {
    get(this: HTMLMediaElement): number {
      const at: number = nativeTime.get!.call(this);
      const entry = asked.get(this);
      // Media clocks keep microseconds.
      return entry && Math.abs(at - entry.at) < 1e-6 ? entry.time : at;
    },
    set(this: HTMLMediaElement, time: number) {
      if (this instanceof HTMLVideoElement) void loadGrid(this);
      if (!(this instanceof HTMLVideoElement) || !this.paused) {
        const entry = seekMedia(this, time, clampMediaTime(this, time));
        if (entry.at === time) asked.delete(this);
        return;
      }
      const target = framePosition(this, time);
      const path = editingProxyPath(this);
      const page = path ? cachedSamples(path, target) : undefined;
      const position = page
        ? samplePosition(sampleAt(page, target), target)
        : target;
      const entry = seekMedia(this, time, clampMediaTime(this, position));
      if (entry.at === time && !path) asked.delete(this);
      if (!path || page) return;
      const source = this.currentSrc || this.src;
      // While an uncached piece starts loading, read its timestamps in parallel. If the
      // target is in the audio tail, reposition even if the native seek never completes.
      void loadSamples(path, target)
        .then((page) => {
          if (
            !page ||
            retired ||
            deferredSeeks.has(this) ||
            asked.get(this) !== entry ||
            (this.currentSrc || this.src) !== source ||
            !this.paused
          )
            return;
          const at = clampMediaTime(
            this,
            samplePosition(sampleAt(page, target), target),
          );
          if (Math.abs(at - entry.at) > 1e-6) seekMedia(this, time, at);
        })
        .catch(() => {
          // The paused picture request reports a failed sample lookup.
        });
    },
  };
  Object.defineProperty(HTMLVideoElement.prototype, "currentTime", {
    configurable: true,
    enumerable: true,
    ...mediaTime,
  });
  // While proxies stand in, the sources seek only once the playhead rests. An abandoned
  // seek still decodes up to a whole GOP, which starves the proxies' decoder.
  const deferredSeeks = new Map<HTMLVideoElement, number>();
  let deferring = false;
  const unsuppress = (video: HTMLVideoElement) => {
    if (!holds.has(video) && !pendingVideos.has(video))
      video.removeAttribute("data-cutroom-held");
  };
  /** Sources with a loaded proxy defer their seeks; the rest seek as usual. */
  const deferSeeks = (video: HTMLVideoElement) => {
    if (Object.hasOwn(video, "currentTime")) return;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => deferredSeeks.get(video) ?? mediaTime.get.call(video),
      set: (time: number) => {
        const path = deferring ? scrubPath(video) : null;
        const proxy = path ? scrubSources.get(path)?.proxy : undefined;
        if (proxy && proxy.readyState >= 2 && !proxy.error) {
          deferredSeeks.set(video, time);
          // Its last decoded frame is from another time; hide it until a proxy covers it.
          video.setAttribute("data-cutroom-held", "");
          return;
        }
        if (deferredSeeks.delete(video)) unsuppress(video);
        mediaTime.set.call(video, time);
      },
    });
  };
  const applySeeks = () => {
    for (const [video, time] of deferredSeeks) {
      deferredSeeks.delete(video);
      unsuppress(video);
      mediaTime.set.call(video, time);
    }
  };
  /**
   * Draws every visible video from its proxy at the time the runtime gave the source.
   * False when a visible video has no proxy ready, so the caller waits for exact frames.
   */
  const showScrubPicture = async (version: number) => {
    await win.__hfWaitForSeekCompletion?.({ videoFrames: false });
    // The runtime shows the last picture until each newly active clip has loaded, so
    // only then does visibility name the clips at this time.
    const deadline = performance.now() + 1000;
    while (document.documentElement.hasAttribute("data-hf-preview-seek-hold")) {
      if (version !== pictureVersion) return true;
      if (performance.now() > deadline) return false;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    if (version !== pictureVersion) return true;
    const videos = visibleVideos();
    const proxies = await Promise.all(
      videos.map((video) => (video.readyState ? proxyFor(video) : null)),
    );
    if (version !== pictureVersion) return true;
    if (!videos.length || proxies.some((proxy) => !proxy)) return false;
    const frames = new Map<HTMLVideoElement, VideoFrame>();
    try {
      for (const [index, video] of videos.entries()) {
        const proxy = proxies[index]!;
        // Its frames are the source's, so it shows the source's frame from the same place.
        // Media clocks keep microseconds, far finer than any frame.
        const at = framePosition(video, video.currentTime);
        if (Math.abs(proxy.currentTime - at) > 1e-4) proxy.currentTime = at;
        const seeked = performance.now() + 1000;
        while (proxy.seeking) {
          if (version !== pictureVersion) return true;
          if (proxy.error || performance.now() > seeked) return false;
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              proxy.removeEventListener("seeked", done);
              proxy.removeEventListener("error", done);
              resolve();
            };
            const timer = setTimeout(done, 100);
            proxy.addEventListener("seeked", done);
            proxy.addEventListener("error", done);
          });
        }
        if (version !== pictureVersion) return true;
        frames.set(video, new VideoFrame(proxy));
      }
      // An exact picture that landed first stays.
      if (version !== pictureVersion || exactVersion === version) return true;
      for (const [video] of holds)
        if (!videos.includes(video)) removeHold(video);
      for (const [video, frame] of frames) {
        showHold(video, frame, true);
        frames.delete(video);
      }
      return true;
    } finally {
      for (const frame of frames.values()) frame.close();
    }
  };
  const refreshPicture = () => {
    const version = ++pictureVersion;
    for (const video of holds.keys()) cancelRelease(video);
    picture = holdPaused(version);
    return picture;
  };
  // The thumbnail browser has no parent player. It still needs the editor's exact paused seek.
  win.__cutroomSeekFrame = async (time) => {
    win.__player?.pause();
    seekRuntime(time);
    win.gsap?.ticker?.tick?.();
    await refreshPicture();
    // Repaint the native video after the exact frame is held. Screenshots use its
    // colour conversion, which can differ from canvas for untagged sources.
    await paint();
    for (const video of holds.keys()) removeHold(video);
  };
  const releasePlaying = (video: HTMLVideoElement) => {
    const hold = holds.get(video);
    if (!hold || hold.callback !== undefined) return;
    hold.callback = video.requestVideoFrameCallback(() => {
      delete hold.callback;
      if (video.paused || !win.__player?.isPlaying()) return;
      removeHold(video);
      if (holds.size === 0) {
        const version = pictureVersion;
        void paint().then(() => {
          if (version === pictureVersion && win.__player?.isPlaying())
            frameStatus(null);
        });
      }
    });
    // Keep observing the video after the timeout so a late frame can replace the hold.
    hold.timer = window.setTimeout(() => {
      frameStatus("The preview did not supply a playback frame in time.");
    }, FRAME_TIMEOUT);
  };
  document.addEventListener(
    "play",
    (event) => {
      if (!retired && event.target instanceof HTMLVideoElement) {
        if (!event.target.paused) forgetDecodedSeek(event.target);
        if (pendingVideos.delete(event.target) && !holds.has(event.target))
          event.target.removeAttribute("data-cutroom-held");
        releasePlaying(event.target);
      }
    },
    true,
  );
  addEventListener("pagehide", () => {
    retired = true;
    seekMutations.disconnect();
    seekAttributes.clear();
    parent.postMessage({ source: "cutroom-preview", type: "unloaded" }, "*");
    pictureVersion += 1;
    clearTimeout(observationTimer);
    cancelAnimationFrame(observationFrame);
    observationFrame = 0;
    cancelAnimationFrame(boxFrame);
    boxFrame = 0;
    boxMutations.disconnect();
    boxResize.disconnect();
    pipelineMedia.disconnect();
    // The parent compositor can still show this document while retiring its iframe.
    // Release decoding resources without erasing the last painted picture.
    for (const frame of editFrames) frame.close();
    editFrames = [];
    for (const [video, hold] of holds) {
      cancelRelease(video);
      hold.frame.close();
    }
    holds.clear();
    for (const video of decodedSeeks.keys()) forgetDecodedSeek(video);
    for (const media of document.querySelectorAll<HTMLMediaElement>(
      "video, audio",
    )) {
      media.pause();
      media.removeAttribute("src");
      media.load();
    }
  });
  addEventListener("message", (event: MessageEvent<unknown>) => {
    if (
      retired ||
      event.source !== parent ||
      !event.data ||
      typeof event.data !== "object"
    )
      return;
    const data = event.data;
    if (
      !("source" in data) ||
      data.source !== "cutroom-viewer" ||
      !("id" in data) ||
      typeof data.id !== "string" ||
      !("action" in data)
    )
      return;
    const id = data.id;
    // A mixer fader on its way: heard now, saved on release. It never moves the playhead.
    if (data.action === "mix-draft") {
      if (
        !("volume" in data) ||
        typeof data.volume !== "number" ||
        !Number.isFinite(data.volume) ||
        data.volume < 0 ||
        !("strip" in data) ||
        typeof data.strip !== "string"
      )
        return;
      const [kind, key] = data.strip.split(/:(.*)/s);
      const group =
        kind === "track"
          ? document.querySelector(
              `hf-audio-group[data-cutroom-track="${CSS.escape(key ?? "")}"]`,
            )?.id
          : kind === "bus"
            ? key
            : null;
      if (kind === "main" || group)
        win.__hf?.audioMeter?.fade(group ?? null, data.volume);
      return;
    }
    const scrub =
      data.action === "seek" && "scrub" in data && data.scrub === true;
    // Every other command starts from the playhead's true time.
    if (!scrub && data.action !== "paint") applySeeks();
    void (async () => {
      switch (data.action) {
        case "track-gains": {
          const changes = "gains" in data ? trackGains(data.gains) : null;
          if (
            !("signature" in data) ||
            data.signature !== state().mixSignature ||
            !("positionDraftClipId" in data) ||
            !(
              data.positionDraftClipId === null ||
              typeof data.positionDraftClipId === "string"
            ) ||
            !changes
          ) {
            reply(id, undefined, { mixApplied: false });
            return;
          }
          for (const { element, volume } of changes)
            if (element.getAttribute("data-volume") !== volume)
              element.setAttribute("data-volume", volume);
          // Undo can return to this document before a committed draft is replaced.
          // Restore its canonical styles, retaining any current gesture.
          if (transforms.size) {
            if (transformDraft?.clipId !== data.positionDraftClipId) {
              cancelAnimationFrame(transformFrame);
              transformFrame = 0;
              transformDraft = null;
            }
            let restored = false;
            for (const element of [...transforms.keys()]) {
              if (
                element.getAttribute("data-hf-cutroom-clip-id") ===
                data.positionDraftClipId
              )
                continue;
              restoreTransform(element);
              restored = true;
            }
            if (restored && !positions.size) {
              scheduleObservation();
              scheduleBox();
              await paint();
            }
          }
          if (positions.size) {
            if (positionDraft?.clipId !== data.positionDraftClipId) {
              cancelAnimationFrame(positionFrame);
              positionFrame = 0;
              positionDraft = null;
            }
            let restored = false;
            for (const [element, original] of positions) {
              if (
                element.getAttribute("data-hf-cutroom-clip-id") ===
                data.positionDraftClipId
              )
                continue;
              element.style.setProperty(
                "translate",
                original.translate,
                original.priority,
              );
              if (element instanceof HTMLVideoElement)
                holds
                  .get(element)
                  ?.canvas.style.setProperty(
                    "translate",
                    original.translate,
                    original.priority,
                  );
              positions.delete(element);
              restored = true;
            }
            if (restored) {
              scheduleObservation();
              scheduleBox();
              await paint();
            }
          }
          reply(id, undefined, { mixApplied: true });
          return;
        }
        case "observe-position":
          if (
            !("clipId" in data) ||
            !(data.clipId === null || typeof data.clipId === "string")
          )
            return;
          if (
            !("text" in data) ||
            !(data.text === null || typeof data.text === "string")
          )
            return;
          observedClip = data.clipId;
          observedText = data.text;
          observedTransform =
            ("transform" in data ? transformCss(data.transform) : null) ?? null;
          postedBox = "";
          observeBox();
          scheduleObservation();
          break;
        case "boxes":
          {
            const start = performance.now();
            const boxes = shownClips();
            performance.measure("cutroom:picture-boxes", {
              start,
              end: performance.now(),
            });
            performance.clearMeasures("cutroom:picture-boxes");
            reply(id, undefined, { boxes });
          }
          break;
        case "hit":
          if (
            !("x" in data) ||
            typeof data.x !== "number" ||
            !Number.isFinite(data.x) ||
            !("y" in data) ||
            typeof data.y !== "number" ||
            !Number.isFinite(data.y)
          )
            return;
          {
            const start = performance.now();
            const hits = clipsAt(data.x, data.y);
            performance.measure("cutroom:picture-hit", {
              start,
              end: performance.now(),
            });
            performance.clearMeasures("cutroom:picture-hit");
            reply(id, undefined, { hits });
          }
          return;
        case "position-fold":
          if (
            "hfId" in data &&
            (data.hfId === null || typeof data.hfId === "string")
          )
            scheduleObservation(data.hfId);
          return;
        case "grade": {
          if (
            !("clipId" in data) ||
            typeof data.clipId !== "string" ||
            !("attribute" in data) ||
            !(data.attribute === null || typeof data.attribute === "string") ||
            !("restore" in data) ||
            typeof data.restore !== "boolean"
          )
            return;
          writeGradeDraft(data.clipId, data.attribute, data.restore);
          const target = clipElement(data.clipId);
          if (target instanceof HTMLVideoElement && parked.has(target)) return;
          if (gradeBypass) writeGradeBypass();
          return;
        }
        case "grade-bypass": {
          if (!("bypass" in data) || typeof data.bypass !== "boolean") return;
          gradeBypass = data.bypass;
          writeGradeBypass();
          return;
        }
        case "keyframe": {
          if (!("clipId" in data) || typeof data.clipId !== "string") return;
          if (!("style" in data)) return;
          if (data.style === null) return writeKeyframe(data.clipId, null);
          if (typeof data.style !== "object") return;
          const style = new Map<string, string>();
          for (const property of keyframeProperties) {
            const value: unknown = Reflect.get(data.style, property);
            if (typeof value === "string") style.set(property, value);
          }
          writeKeyframe(data.clipId, style);
          return;
        }
        case "region": {
          if (
            !("css" in data) ||
            !(data.css === null || typeof data.css === "string") ||
            !("seek" in data) ||
            typeof data.seek !== "boolean"
          )
            return;
          writeRegion(data.css);
          // A zoom set aside or brought back is a new CSS animation: seek it to the frame shown,
          // which also redraws held video frames at their new place.
          if (data.seek && win.__player && !win.__player.isPlaying()) {
            seekRuntime(win.__player.getTime());
            await refreshPicture().catch(reportFrameFailure);
          }
          scheduleBox();
          return;
        }
        case "transform": {
          if (!("clipId" in data) || typeof data.clipId !== "string") return;
          const style =
            "style" in data
              ? data.style === null
                ? null
                : transformCss(data.style)
              : undefined;
          const onGsap =
            "onGsap" in data ? transformCss(data.onGsap) : undefined;
          if (style === undefined || !onGsap) return;
          transformDraft = { clipId: data.clipId, style, onGsap };
          if (!transformFrame)
            transformFrame = requestAnimationFrame(writeTransform);
          return;
        }
        case "position":
          if (
            !("clipId" in data) ||
            typeof data.clipId !== "string" ||
            !("x" in data) ||
            !("y" in data) ||
            !(
              data.x === null ||
              (typeof data.x === "number" && Number.isFinite(data.x))
            ) ||
            !(
              data.y === null ||
              (typeof data.y === "number" && Number.isFinite(data.y))
            )
          )
            return;
          positionDraft = { clipId: data.clipId, x: data.x, y: data.y };
          if (!positionFrame)
            positionFrame = requestAnimationFrame(writePosition);
          return;
        case "timing": {
          // A seek still settling belongs to its record, including its late writes.
          if (recording) {
            await win.__hfWaitForSeekCompletion?.().catch(() => {});
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
          if (
            !initialTiming ||
            confirmedStructure === null ||
            liveStructure() !== confirmedStructure
          )
            throw new Error(
              "The live preview document changed or requires a reload.",
            );
          if (updatingTiming || win.__player?.isPlaying() || !win.__player)
            throw new Error("Timing updates require a paused preview.");
          if (
            !("timing" in data) ||
            !data.timing ||
            typeof data.timing !== "object" ||
            !("mixSignature" in data) ||
            typeof data.mixSignature !== "string" ||
            !("gains" in data) ||
            !("expectedRevision" in data) ||
            data.expectedRevision !== timingRevision ||
            !("time" in data) ||
            typeof data.time !== "number" ||
            !Number.isFinite(data.time) ||
            data.time < 0
          )
            throw new Error("The preview timing revision changed.");
          // The parent validates the server snapshot. Check again at the isolated boundary,
          // then resolve every target before changing any linked partner.
          const timing = data.timing;
          if (
            !("structure" in timing) ||
            timing.structure !== initialTiming.structure ||
            !("revision" in timing) ||
            typeof timing.revision !== "string" ||
            !("clips" in timing) ||
            !Array.isArray(timing.clips) ||
            !("titleStyle" in timing) ||
            !("duration" in timing) ||
            !(timing.duration === null || typeof timing.duration === "string")
          )
            throw new Error("The preview document changed.");
          const nextDuration = timing.duration;
          const nextTitleStyle = timing.titleStyle;
          if (
            !(nextTitleStyle === null || typeof nextTitleStyle === "string") ||
            (nextTitleStyle === null) !== (titleStyle === null)
          )
            throw new Error("The title stylesheet changed.");
          const writes: {
            id: string;
            element: Element;
            values: [string, string | null][];
            text:
              | NonNullable<PreviewTiming["clips"][number]["title"]>["text"]
              | null;
          }[] = [];
          const styles = [...document.querySelectorAll("style")].filter(
            (style) =>
              titleStyle !== null &&
              titleStyle !== undefined &&
              style.textContent?.includes(titleStyle),
          );
          if (titleStyle !== null && styles.length !== 1)
            throw new Error("The title stylesheet changed.");
          const elements = new Map<string, Element>();
          for (const element of document.querySelectorAll(
            "[data-hf-cutroom-clip-id]",
          )) {
            const id = element.getAttribute("data-hf-cutroom-clip-id")!;
            if (elements.has(id))
              throw new Error("The preview clip is ambiguous.");
            elements.set(id, element);
          }
          const attributes = [
            "data-start",
            "data-duration",
            "data-end",
            "data-media-start",
            "data-playback-start",
            "data-playback-rate",
          ];
          const clips: unknown[] = timing.clips;
          const markup = new Map<string, unknown>();
          const incoming = clips.map((clip): LiveClip => {
            if (
              !clip ||
              typeof clip !== "object" ||
              !("id" in clip) ||
              typeof clip.id !== "string" ||
              !("slot" in clip) ||
              !(clip.slot === null || typeof clip.slot === "string") ||
              !("body" in clip) ||
              !(clip.body === null || typeof clip.body === "string") ||
              !("space" in clip) ||
              typeof clip.space !== "string"
            )
              throw new Error("The preview clips changed.");
            markup.set(clip.id, Reflect.get(clip, "html"));
            return {
              id: clip.id,
              slot: clip.slot,
              body: clip.body,
              space: clip.space,
            };
          });
          const change = plan(liveClips, incoming);
          if ("refuse" in change) throw new Error(change.refuse);
          const previous = new Map(liveClips.map((clip) => [clip.id, clip]));
          const spaces = new Map(incoming.map(({ id, space }) => [id, space]));
          const bodies = new Map(incoming.map(({ id, body }) => [id, body]));
          // A removed clip goes with the whitespace before it. Check both before any write.
          const ownSpace = (element: Element | undefined, space: string) => {
            const before = element?.previousSibling;
            if (
              !element ||
              (space && !(before instanceof Text && before.data === space))
            )
              throw new Error("The preview clip is missing.");
            return space ? before! : null;
          };
          const replaced = new Set(change.insert.map(({ id }) => id));
          const removals = change.remove.map((id) => {
            const element = elements.get(id);
            const space = ownSpace(element, previous.get(id)!.space);
            // Its new markup would be animated too, and only a fresh load finds that.
            if (
              replaced.has(id) &&
              element!.getAnimations({ subtree: true }).length
            )
              throw new Error("This clip needs animation discovery.");
            return { id, element: element!, space };
          });
          const removed = new Set(change.remove);
          // Added clips come from saved markup, parsed inertly. Animation and Position state
          // are initialized through a fresh document instead of this live insertion path.
          const added = new Map<string, Element>();
          const inserts = change.insert.map(({ id, after, before }) => {
            const html = markup.get(id);
            const template = document.createElement("template");
            if (typeof html === "string") template.innerHTML = html;
            const parsed = template.content.firstElementChild;
            const reuse = removedMedia.get(`${id}\0${bodies.get(id)}`);
            // Created in this document, so media choose and load their source here: one
            // made in the inert template stays without a source until something resets it.
            const element =
              reuse?.localName === parsed?.localName &&
              parsed?.childElementCount === 0
                ? reuse
                : parsed && document.importNode(parsed, true);
            const anchor = after ?? before!;
            if (
              !element ||
              template.content.childNodes.length !== 1 ||
              element.getAttribute("data-hf-cutroom-clip-id") !== id ||
              !(
                added.has(anchor) ||
                (elements.has(anchor) && !removed.has(anchor))
              )
            )
              throw new Error("The added clip cannot be placed.");
            if (["data-x", "data-y"].some((name) => element.hasAttribute(name)))
              throw new Error("A positioned clip needs a fresh document.");
            if (
              element.hasAttribute("data-var-src") ||
              element.querySelector("[data-var-src]")
            )
              throw new Error(
                "A variable-bound source needs a fresh document.",
              );
            if (
              [...element.attributes].some(
                ({ name, value }) =>
                  name.startsWith("data-transition-") ||
                  ((name === "data-title-in" || name === "data-title-out") &&
                    value !== "none"),
              )
            )
              throw new Error("This clip needs animation discovery.");
            added.set(id, element);
            return { id, element, parsed: parsed!, after, before };
          });
          const root = document.querySelector("[data-composition-id]");
          if (!root) throw new Error("The preview composition is missing.");
          const records = new Map<
            string,
            { titleAttributes: string[] | null; animated: boolean }
          >();
          for (const [index, clip] of clips.entries()) {
            if (
              !clip ||
              typeof clip !== "object" ||
              !("values" in clip) ||
              !clip.values ||
              typeof clip.values !== "object"
            )
              throw new Error("The preview clips changed.");
            const { id } = incoming[index]!;
            const element = added.get(id) ?? elements.get(id);
            if (!element) throw new Error("The preview clip is missing.");
            const values: [string, string | null][] = [];
            for (const name of attributes) {
              const value: unknown = Reflect.get(clip.values, name);
              if (
                value !== null &&
                (typeof value !== "string" ||
                  value.trim() === "" ||
                  !Number.isFinite(Number(value)) ||
                  Number(value) < 0)
              )
                throw new Error("Invalid preview timing.");
              values.push([name, value]);
            }
            const title: unknown = Reflect.get(clip, "title");
            const expected = added.has(id)
              ? {
                  titleAttributes:
                    title &&
                    typeof title === "object" &&
                    "attributes" in title &&
                    Array.isArray(title.attributes)
                      ? title.attributes.map((pair: unknown) =>
                          Array.isArray(pair) ? String(pair[0]) : "",
                        )
                      : null,
                  animated: false,
                }
              : previous.get(id)!;
            records.set(id, expected);
            let text:
              | NonNullable<PreviewTiming["clips"][number]["title"]>["text"]
              | null = null;
            if (expected.titleAttributes) {
              if (
                !title ||
                typeof title !== "object" ||
                !("attributes" in title) ||
                !Array.isArray(title.attributes) ||
                title.attributes.length !== expected.titleAttributes.length ||
                !("text" in title) ||
                !Array.isArray(title.text) ||
                !title.text.every(
                  (part): part is string | { br: string | null } =>
                    typeof part === "string" ||
                    (part !== null &&
                      typeof part === "object" &&
                      "br" in part &&
                      (part.br === null || typeof part.br === "string")),
                )
              )
                throw new Error("Invalid preview title.");
              for (const [index, pair] of title.attributes.entries()) {
                if (
                  !Array.isArray(pair) ||
                  pair.length !== 2 ||
                  pair[0] !== expected.titleAttributes[index] ||
                  !(pair[1] === null || typeof pair[1] === "string")
                )
                  throw new Error("Invalid preview title attributes.");
                values.push([pair[0], pair[1]]);
              }
              // The pinned CSS adapter discovers animated elements at initialization.
              // A title loaded with both directions None needs that fresh discovery.
              if (
                !animatedTitles.has(id) &&
                values.some(
                  ([name, value]) =>
                    (name === "data-title-in" || name === "data-title-out") &&
                    value !== "none",
                )
              )
                throw new Error("This title needs animation discovery.");
              // Scaled titles can paint different pixels even when their computed
              // state matches a fresh load. Keep those edits on the canonical reload path.
              const changed =
                values.some(
                  ([name, value]) => element.getAttribute(name) !== value,
                ) ||
                JSON.stringify(titleNodes(element)) !==
                  JSON.stringify(title.text) ||
                nextTitleStyle !== titleStyle;
              if (
                changed &&
                values.some(
                  ([name, value]) =>
                    (name === "data-title-in" || name === "data-title-out") &&
                    (value === "scale" ||
                      element.getAttribute(name) === "scale"),
                )
              )
                throw new Error("Scale titles require fresh rasterization.");
              text = title.text;
            } else if (title !== null)
              throw new Error("The preview titles changed.");
            writes.push({ id, element, values, text });
          }
          const gains = trackGains(data.gains);
          if (!gains) throw new Error("The preview track gains changed.");
          updatingTiming = true;
          try {
            stopRecording();
            seekAttributes.clear();
            rememberTitleAnimations();
            // Each write records its inverse, so a refused result leaves the page as it was
            // before anything paints. Reading animations here also settles the old styles.
            const undo: (() => void)[] = [];
            const write = (
              element: Element,
              name: string,
              value: string | null,
            ) => {
              const old = element.getAttribute(name);
              if (old === value) return false;
              undo.push(() =>
                old === null
                  ? element.removeAttribute(name)
                  : element.setAttribute(name, old),
              );
              if (value === null) element.removeAttribute(name);
              else element.setAttribute(name, value);
              return true;
            };
            const running = new Set(document.getAnimations());
            // Synchronous writes are one MutationObserver batch to the runtime.
            for (const { id, element, space } of removals) {
              const parent = element.parentNode!;
              const next = element.nextSibling;
              undo.push(() => {
                parent.insertBefore(element, next);
                if (space) element.before(space);
              });
              // A removed video's held picture stays until the new frame replaces it.
              space?.remove();
              element.remove();
              if (element instanceof HTMLMediaElement) {
                const key = `${id}\0${previous.get(id)!.body}`;
                removedMedia.delete(key);
                removedMedia.set(key, element);
                if (removedMedia.size > 8)
                  removedMedia.delete(removedMedia.keys().next().value!);
              }
              sourceTexts.delete(id);
              titleAnimations.delete(id);
              animatedTitles.delete(id);
              if (element instanceof HTMLVideoElement) {
                deferredSeeks.delete(element);
                forgetDecodedSeek(element);
              }
              if (
                element instanceof HTMLElement ||
                element instanceof SVGElement
              ) {
                positions.delete(element);
                transforms.delete(element);
              }
            }
            const live = (id: string) => added.get(id) ?? elements.get(id)!;
            for (const { id, element, parsed, after, before } of inserts) {
              // A reused element takes exactly the saved markup's attributes.
              if (element !== parsed && element.ownerDocument === document) {
                removedMedia.delete(`${id}\0${bodies.get(id)}`);
                for (const { name } of [...element.attributes])
                  if (!parsed.hasAttribute(name)) write(element, name, null);
                for (const { name, value } of parsed.attributes)
                  write(element, name, value);
              }
              const space = spaces.get(id)!;
              const nodes = space
                ? [document.createTextNode(space), element]
                : [element];
              // Load it now; the runtime would raise its preload only on its own schedule.
              if (element instanceof HTMLMediaElement)
                write(element, "preload", "auto");
              // A new video stays hidden until its first decoded frame is held.
              if (element instanceof HTMLVideoElement) {
                write(element, "data-cutroom-held", "");
                pendingVideos.add(element);
                undo.push(() => pendingVideos.delete(element));
              }
              undo.push(() => {
                for (const node of nodes) node.remove();
              });
              if (after) {
                let anchor: Element = live(after);
                while (
                  anchor.nextElementSibling?.matches(
                    "[data-cutroom-video-hold], [data-cutroom-edit-frame]",
                  ) &&
                  anchor.nextSibling === anchor.nextElementSibling
                )
                  anchor = anchor.nextElementSibling;
                anchor.after(...nodes);
              } else {
                const anchor = live(before!);
                (ownSpace(anchor, spaces.get(before!)!) ?? anchor).before(
                  ...nodes,
                );
              }
              const text = [...element.childNodes]
                .map((node) =>
                  node.nodeType === Node.TEXT_NODE
                    ? (node.nodeValue ?? "")
                    : node instanceof HTMLBRElement
                      ? "\n"
                      : "",
                )
                .join("");
              sourceTexts.set(id, [
                canonicalWords(text),
                canonicalWords(text.replace(/[\t\n\f\r ]+/g, " ")),
              ]);
            }
            write(root, "data-duration", nextDuration);
            // The runtime positions clips it has not laid out yet on its next layout pass,
            // at most three times a second. Wait for it so its writes join this document
            // before it is drawn, rather than changing it after it is confirmed.
            const manifest = inserts.length ? win.__clipManifest : undefined;
            const changedTitles = new Set<Element>();
            for (const { id, element, values, text } of writes) {
              for (const [name, value] of values)
                if (write(element, name, value) && text)
                  changedTitles.add(element);
              if (text) {
                const current = titleNodes(element);
                if (JSON.stringify(current) !== JSON.stringify(text)) {
                  const old = [...element.childNodes];
                  undo.push(() => element.replaceChildren(...old));
                  element.replaceChildren(
                    ...text.map((part) => {
                      if (typeof part === "string")
                        return document.createTextNode(part);
                      const br = document.createElement("br");
                      if (part.br !== null)
                        br.setAttribute("data-hf-id", part.br);
                      return br;
                    }),
                  );
                  changedTitles.add(element);
                }
                sourceTexts.set(id, [
                  canonicalWords(
                    text
                      .map((part) => (typeof part === "string" ? part : "\n"))
                      .join(""),
                  ),
                  canonicalWords(
                    text
                      .map((part) =>
                        typeof part !== "string"
                          ? "\n"
                          : part.replace(/[\t\n\f\r ]+/g, " "),
                      )
                      .join(""),
                  ),
                ]);
              }
            }
            for (const { element, volume } of gains)
              write(element, "data-volume", volume);
            if (titleStyle && nextTitleStyle && nextTitleStyle !== titleStyle) {
              const style = styles[0]!;
              const old = style.textContent;
              undo.push(() => (style.textContent = old));
              // A replacer function keeps $-sequences in the CSS literal.
              style.textContent = style.textContent!.replace(
                titleStyle,
                () => nextTitleStyle,
              );
              for (const { element, text } of writes)
                if (text) changedTitles.add(element);
            }
            // The runtime finds CSS animations and transitions only when a document loads.
            // Authored rules such as :has() or :nth-child() can start one on any element when
            // clips come and go, and it would run in real time. Only changed titles, which are
            // recreated below, may start one.
            const started = document.getAnimations().filter((animation) => {
              if (running.has(animation)) return false;
              const target =
                animation.effect instanceof KeyframeEffect
                  ? animation.effect.target
                  : null;
              return ![...changedTitles].some(
                (title) => target && title.contains(target),
              );
            });
            if (started.length) {
              for (const step of undo.reverse()) step();
              for (const animation of document.getAnimations())
                if (!running.has(animation)) animation.cancel();
              throw new Error("This edit needs animation discovery.");
            }
            // Resolve new font metrics before recreating animation effects.
            for (const element of changedTitles)
              element.getBoundingClientRect();
            rememberTitleAnimations();
            if (changedTitles.size) await document.fonts.ready;
            // Recreate the changed title's CSS animations before seeking. The pinned
            // adapter retains handles across name/rule changes and can revive canceled
            // effects, so merely setting new attributes can leave two entrances composed.
            const canceled: Promise<void>[] = [];
            const retiredAnimations: Animation[] = [];
            for (const element of changedTitles) {
              if (!(
                element instanceof HTMLElement || element instanceof SVGElement
              ))
                throw new Error("The title cannot refresh its animations.");
              const clipId = element.getAttribute("data-hf-cutroom-clip-id")!;
              const animations = [
                ...new Set([
                  ...(titleAnimations.get(clipId) ?? []),
                  ...element.getAnimations(),
                ]),
              ].filter((animation) => animation.playState !== "idle");
              if (
                animations.some(
                  (animation) =>
                    animation.effect instanceof KeyframeEffect &&
                    animation.effect.pseudoElement,
                ) ||
                [...element.querySelectorAll("br")].some((br) =>
                  getComputedStyle(br)
                    .animationName.split(",")
                    .some((name) => name.trim() !== "none"),
                )
              )
                throw new Error("This title needs animation discovery.");
              for (const animation of animations) {
                retiredAnimations.push(animation);
                canceled.push(
                  new Promise<void>((resolve) =>
                    animation.addEventListener("cancel", () => resolve(), {
                      once: true,
                    }),
                  ),
                );
              }
              const style = element.getAttribute("style");
              element.style.setProperty("animation-name", "none", "important");
              element.getBoundingClientRect();
              for (const animation of [
                ...animations,
                ...element.getAnimations(),
              ])
                animation.cancel();
              if (style === null) element.removeAttribute("style");
              else element.setAttribute("style", style);
              // Flush the replacement animations before the runtime seeks them.
              element.getBoundingClientRect();
              titleAnimations.set(clipId, new Set(element.getAnimations()));
            }
            // The WAAPI adapter drops cached handles on the browser's cancel event,
            // which arrives after microtasks. Seeking earlier can revive the old effects.
            await Promise.all(canceled);
            if (
              retiredAnimations.some(
                (animation) => animation.playState !== "idle",
              )
            )
              throw new Error("The title animations did not retire.");
            // Let the runtime invalidate its descriptor cache before seeking.
            await Promise.resolve();
            if (inserts.length) await layoutPass(manifest);
            seekRuntime(data.time);
            document
              .querySelector('meta[name="cutroom-mix-signature"]')
              ?.setAttribute("content", data.mixSignature);
            const expectedStructure = liveStructure();
            const restored = refreshPicture();
            const version = pictureVersion;
            await restored;
            await paint();
            if (
              retired ||
              version !== pictureVersion ||
              win.__player.isPlaying()
            )
              throw new Error("The preview timing update was superseded.");
            clearEditPicture();
            if (liveStructure() !== expectedStructure)
              throw new Error("The live preview changed while drawing.");
            const ids = new Set(incoming.map(({ id }) => id));
            if (
              [...document.querySelectorAll("[data-hf-cutroom-clip-id]")]
                .map((element) =>
                  element.getAttribute("data-hf-cutroom-clip-id")!,
                )
                .filter((id) => ids.has(id))
                .join("\0") !== incoming.map(({ id }) => id).join("\0")
            )
              throw new Error("The preview clips are out of order.");
            confirmedStructure = expectedStructure;
            liveClips = incoming.map((clip) => ({
              ...records.get(clip.id)!,
              ...clip,
            }));
            timingRevision = timing.revision;
            titleStyle = nextTitleStyle;
            parkRootVideos();
            scheduleObservation();
            scheduleBox();
          } finally {
            updatingTiming = false;
          }
          break;
        }
        case "inspect":
          rememberTitleAnimations();
          break;
        case "pipeline": {
          const nativeIds = "native" in data ? data.native : undefined;
          if (
            !("active" in data) ||
            typeof data.active !== "boolean" ||
            !("drawn" in data) ||
            !Array.isArray(data.drawn) ||
            !data.drawn.every((id) => typeof id === "string") ||
            (nativeIds !== undefined &&
              (!Array.isArray(nativeIds) ||
                !nativeIds.every((id) => typeof id === "string")))
          )
            return;
          const drawn = new Set<string>(data.drawn);
          if (data.active && Array.isArray(nativeIds)) {
            const native = new Set<string>(nativeIds);
            // A retained document can still contain a clip deleted from the new plan.
            // Keep it parked until this document leaves, or the plan puts it on HyperFrames.
            for (const video of rootMedia("video")) {
              const id = clipId(video);
              if (id !== null && pipelineDrawn.has(id) && !native.has(id))
                drawn.add(id);
            }
          }
          if (
            data.active === pipelineActive &&
            drawn.size === pipelineDrawn.size &&
            [...drawn].every((id) => pipelineDrawn.has(id))
          ) {
            await picture;
            await paint();
            break;
          }
          // The runtime took the parked videos as seeked; seek again so they load and draw.
          if (setPipeline(data.active, drawn) && !win.__player?.isPlaying()) {
            seekRuntime(win.__player?.getTime() ?? 0);
            await refreshPicture();
          }
          // Parking does not replace a seek already drawing the remaining native videos.
          await picture;
          await paint();
          break;
        }
        case "cancel-edit":
          // Let the one pending seek finish without painting a stale edge. The queued
          // playhead seek then restores the picture, even when the source is still loading.
          pictureVersion += 1;
          return;
        case "meter": {
          if (!("enabled" in data) || typeof data.enabled !== "boolean") return;
          metering = data.enabled;
          const showStrips =
            metering && "strips" in data && data.strips === true;
          if (metering && stripMetering && !showStrips)
            win.__hf?.audioMeter?.clearPre();
          stripMetering = showStrips;
          cancelAnimationFrame(animation);
          animation = 0;
          if (metering) levels();
          else win.__hf?.audioMeter?.stop();
          break;
        }
        case "play":
          clearEditPicture();
          pictureVersion += 1;
          for (const video of holds.keys()) releasePlaying(video);
          // Playback changes which clips show, as seeks do.
          recordRuntime();
          residentAudio(false);
          win.__player?.play();
          clearInterval(residency);
          if (pipelineActive)
            residency = window.setInterval(() => residentAudio(false), 1000);
          observePlaying();
          refreshBoxAnimations();
          if (metering && !animation) levels();
          break;
        case "pause":
          win.__player?.pause();
          clearInterval(residency);
          cancelAnimationFrame(animation);
          animation = 0;
          if (metering) levels();
          await refreshPicture();
          settleRecording(seekGeneration);
          clearTimeout(observationTimer);
          scheduleObservation();
          scheduleBox();
          break;
        case "seek":
          if (
            !("time" in data) ||
            typeof data.time !== "number" ||
            !Number.isFinite(data.time) ||
            data.time < 0
          )
            return;
          if ("edit" in data && Array.isArray(data.edit) && data.edit.length) {
            const edges: EditFrame[] = [];
            if (data.edit.length > 2) return;
            for (const edge of data.edit) {
              if (
                !edge ||
                typeof edge !== "object" ||
                !("clipId" in edge) ||
                typeof edge.clipId !== "string" ||
                !("time" in edge) ||
                typeof edge.time !== "number" ||
                !Number.isFinite(edge.time) ||
                edge.time < 0
              )
                return;
              edges.push({ clipId: edge.clipId, time: edge.time });
            }
            win.__player?.pause();
            const version = ++pictureVersion;
            picture = showEditPicture(edges, version);
            await picture;
            break;
          }
          if (scrub && !win.__player?.isPlaying()) {
            // A moving playhead answers once proxies show its frame. If no newer seek
            // arrives meanwhile, the sources then seek and their exact frames replace them.
            const version = ++pictureVersion;
            for (const video of document.querySelectorAll("video"))
              deferSeeks(video);
            deferring = true;
            try {
              seekRuntime(data.time);
            } finally {
              deferring = false;
            }
            residentAudio(true);
            if (await showScrubPicture(version).catch(() => false)) {
              if (version === pictureVersion) clearEditPicture();
              picture = new Promise((resolve) =>
                setTimeout(resolve, SCRUB_REST_MS),
              ).then(async () => {
                if (version !== pictureVersion) return;
                residentAudio(false);
                applySeeks();
                const restored = refreshPicture();
                const exact = pictureVersion;
                await restored;
                if (exact === pictureVersion) clearEditPicture();
              });
              picture.catch(reportFrameFailure);
            } else if (version === pictureVersion) {
              applySeeks();
              const restored = refreshPicture();
              const exact = pictureVersion;
              await restored;
              if (exact === pictureVersion) clearEditPicture();
            }
            scheduleObservation();
            scheduleBox();
            break;
          }
          seekRuntime(data.time);
          residentAudio(false);
          const paused = !win.__player?.isPlaying();
          if (paused) {
            const restored = refreshPicture();
            const version = pictureVersion;
            await restored;
            if (version === pictureVersion) clearEditPicture();
          }
          scheduleObservation();
          scheduleBox();
          if (paused) await paint();
          break;
        case "mute":
          if (!("muted" in data) || typeof data.muted !== "boolean") return;
          win.postMessage(
            {
              source: "hf-parent",
              type: "control",
              action: "set-muted",
              muted: data.muted,
            },
            "*",
          );
          break;
        case "check-ramp": {
          const deadline = AbortSignal.timeout(4000);
          const loaded = new Set<string>();
          for (const audio of document.querySelectorAll<HTMLAudioElement>(
            "audio[src]",
          )) {
            const src = audio.getAttribute("src") ?? "";
            const duration = rampFiles.get(src);
            if (duration === undefined) continue;
            if (parked.has(audio)) {
              // Keep distant clips parked. Validate their WAV with one temporary
              // decoder at a time instead of trusting the parked ready-state shim.
              if (loaded.has(src)) continue;
              const probe = new Audio();
              probe.crossOrigin = "anonymous";
              probe.preload = "auto";
              probe.src = src;
              try {
                await loadRamp(probe, duration, deadline);
              } finally {
                probe.removeAttribute("src");
                probe.load();
              }
            } else {
              await loadRamp(audio, duration, deadline);
            }
            loaded.add(src);
          }
          if (loaded.size !== rampFiles.size)
            throw new Error("A prepared ramp audio clip is missing.");
          break;
        }
        case "paint":
          discoverScrubs();
          await picture;
          await paint();
          if (initialTiming && confirmedStructure === null) {
            for (const clip of liveClips) {
              const element = clipElement(clip.id);
              if (
                clip.animated &&
                element &&
                getComputedStyle(element)
                  .animationName.split(",")
                  .some((name) => name.trim() !== "none")
              )
                if (
                  getComputedStyle(element)
                    .animationName.split(",")
                    .filter((name) => name.trim() !== "none")
                    .every((name) =>
                      [...(titleAnimations.get(clip.id) ?? [])].some(
                        (animation) =>
                          animation instanceof CSSAnimation &&
                          animation.animationName === name.trim(),
                      ),
                    )
                )
                  animatedTitles.add(clip.id);
            }
            confirmedStructure = liveStructure();
          }
          scheduleObservation();
          scheduleBox();
          break;
        default:
          return;
      }
      reply(id);
    })().catch((error: unknown) =>
      reply(id, error instanceof Error ? error.message : String(error)),
    );
  });
}

/** Bind the source timeline's identities before compilation's generated HF ids can rename them.
 * The compiler and this adapter use the same HF stamping function. Our data-hf marker is excluded
 * from its content hash, so it cannot change the runtime's identities or animation targets.
 */
export function withPreviewClipIdentities(
  html: string,
  source = html,
  scope: CompositionScope = "document",
  mediaLengths: ReadonlyMap<string, number> = new Map(),
) {
  let locations: Map<number, string>;
  try {
    locations = compositionClipLocations(source, scope, mediaLengths);
  } catch (error) {
    // Unsupported timelines still have a viewable picture, but no selectable timeline clips.
    if (!(error instanceof TimelineError)) throw error;
    return html;
  }
  const visit = (
    nodes: DefaultTreeAdapterTypes.ChildNode[],
    read: (node: DefaultTreeAdapterTypes.Element) => void,
  ) => {
    for (const node of nodes) {
      if (!("tagName" in node)) continue;
      read(node);
      visit(node.childNodes, read);
      if ("content" in node) visit(node.content.childNodes, read);
    }
  };
  const mark = (
    html: string,
    identify: (node: DefaultTreeAdapterTypes.Element) => string | undefined,
  ) => {
    const edits: { at: number; end: number; text: string }[] = [];
    visit(parse(html, { sourceCodeLocationInfo: true }).childNodes, (node) => {
      const id = identify(node);
      const start = node.sourceCodeLocation?.startTag;
      if (!id || !start) return;
      const existing =
        node.sourceCodeLocation?.attrs?.["data-hf-cutroom-clip-id"];
      const at = start.startOffset + node.tagName.length + 1;
      const value = id
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;");
      edits.push({
        at: existing?.startOffset ?? at,
        end: existing?.endOffset ?? at,
        text: `${existing ? "" : " "}data-hf-cutroom-clip-id="${value}"`,
      });
    });
    return edits
      .sort((a, b) => b.at - a.at)
      .reduce(
        (html, edit) =>
          html.slice(0, edit.at) + edit.text + html.slice(edit.end),
        html,
      );
  };
  const marked = mark(source, (node) =>
    locations.get(node.sourceCodeLocation?.startOffset ?? -1),
  );
  if (source === html) return marked;
  const identities = new Map<string, (string | undefined)[]>();
  visit(parse(ensureHfIds(marked)).childNodes, (node) => {
    const attrs = new Map(node.attrs.map(({ name, value }) => [name, value]));
    const id = attrs.get("data-hf-cutroom-clip-id");
    const hfId = attrs.get("data-hf-id");
    if (hfId) {
      const matches = identities.get(hfId) ?? [];
      matches.push(id);
      identities.set(hfId, matches);
    }
  });
  return mark(ensureHfIds(html), (node) =>
    identities
      .get(node.attrs.find(({ name }) => name === "data-hf-id")?.value ?? "")
      ?.shift(),
  );
}

export function previewDocument(
  html: string,
  composition = "index.html",
  dependencies: string | null = null,
  mixSignature?: string,
  rampPending = false,
  rampWindows: [src: string, seconds: number][] = [],
) {
  if (!html.includes("data-hf-cutroom-clip-id="))
    html = withPreviewClipIdentities(html);
  const document = parse(html, { sourceCodeLocationInfo: true });
  const root = document.childNodes.find((node) => node.nodeName === "html");
  const head =
    root && "childNodes" in root
      ? root.childNodes.find((node) => node.nodeName === "head")
      : undefined;
  const location = head && "tagName" in head ? head.sourceCodeLocation : null;
  const offset = location?.startTag?.endOffset ?? html.length;
  const sourceTexts: [string, string[]][] = [];
  const { sources, edits } = compositionScriptSources(document, composition);
  // The opaque frame needs CORS media for Web Audio, including gain above unity and its level tap.
  // Only the served preview changes; project source and its producer input stay untouched.
  const visit = (nodes: DefaultTreeAdapterTypes.ChildNode[], fps = 30) => {
    for (const node of nodes) {
      if (!("tagName" in node)) continue;
      const rate = node.attrs.find(({ name }) => name === "data-fps");
      const parsed = rate && parseFpsWithDefault(rate.value);
      const nodeFps = parsed?.ok ? parsed.value.num / parsed.value.den : fps;
      // The runtime snaps visibility to frames, but seeks media using raw seconds.
      // Align those windows in served documents so rounded edit times cannot show
      // a piece that the seek still considers to be in the future.
      const timing = new Map(
        node.attrs.map(({ name, value }) => [name, value]),
      );
      const id = timing.get("data-hf-cutroom-clip-id");
      if (id && timing.has("data-start")) {
        const text = node.childNodes
          .map((child) =>
            "value" in child
              ? child.value
              : "tagName" in child && child.tagName === "br"
                ? "\n"
                : "",
          )
          .join("");
        sourceTexts.push([
          id,
          [
            canonicalText(text),
            canonicalText(
              node.childNodes
                .map((child) =>
                  "value" in child
                    ? child.value.replace(/[\t\n\f\r ]+/g, " ")
                    : "tagName" in child && child.tagName === "br"
                      ? "\n"
                      : "",
                )
                .join(""),
            ),
          ],
        ]);
      }
      const start = Number(timing.get("data-start"));
      const duration = Number(timing.get("data-duration"));
      const end = timing.has("data-duration")
        ? start + duration
        : Number(timing.get("data-end"));
      if (Number.isFinite(start)) {
        const window = exportClipWindow(start, end, nodeFps);
        for (const [name, value] of [
          ["data-start", window.start],
          ["data-duration", window.end - window.start],
          ["data-end", window.end],
        ] as const) {
          const location = node.sourceCodeLocation?.attrs?.[name];
          if (
            location &&
            Number.isFinite(value) &&
            (window.start !== start || window.end !== end) &&
            Number(timing.get(name)) !== value
          )
            edits.push({
              offset: location.startOffset,
              end: location.endOffset,
              text: `${name}="${value}"`,
            });
        }
      }
      if (
        (node.tagName === "audio" || node.tagName === "video") &&
        !node.attrs.some(({ name }) => name === "crossorigin")
      ) {
        const start = node.sourceCodeLocation?.startTag?.startOffset;
        if (start !== undefined)
          edits.push({
            offset: start + node.tagName.length + 1,
            end: start + node.tagName.length + 1,
            text: ' crossorigin="anonymous"',
          });
      }
      visit(node.childNodes, nodeFps);
      if ("content" in node) visit(node.content.childNodes, nodeFps);
    }
  };
  visit(document.childNodes);
  const normalized = edits
    .sort((a, b) => b.offset - a.offset)
    .reduce(
      (source, edit) =>
        source.slice(0, edit.offset) + edit.text + source.slice(edit.end),
      html,
    );
  const timing =
    dependencies === null ? null : previewTiming(normalized, dependencies);
  // Escape '<' so authored words cannot terminate the bridge's script element.
  const args = JSON.stringify([
    sourceTexts,
    timing && {
      ...timing,
      clips: timing.clips.map(({ id, title, slot, body, space }) => ({
        id,
        slot,
        body,
        space,
        titleAttributes: title?.attributes.map(([name]) => name) ?? null,
        animated: Boolean(
          title?.attributes.some(
            ([name, value]) =>
              (name === "data-title-in" || name === "data-title-out") &&
              value !== "none",
          ),
        ),
      })),
    },
    rampPending,
    rampWindows,
  ]).replaceAll("<", "\\u003c");
  const bridge = `${mixSignature ? `<meta name="cutroom-mix-signature" content="${mixSignature}">` : ""}${compositionDiagnosticsScript(composition, sources)}<script>(${installPreviewBridge.toString()})(${liveUpdatePlan.toString()}, ${frameSeek.toString()}, ${JSON.stringify([MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE])}, ...${args});</script>`;
  // All normalization edits are in the body or attributes after the head's opening tag.
  const insertion = location?.startTag ? offset : normalized.length;
  return {
    html: normalized.slice(0, insertion) + bridge + normalized.slice(insertion),
    timing,
  };
}

export function withPreviewBridge(html: string, composition = "index.html") {
  return previewDocument(html, composition).html;
}
