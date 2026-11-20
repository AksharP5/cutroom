import { parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";

/** Find grades and mounted compositions before the producer chooses its browser mode. */
export function adjustmentSources(html: string) {
  let graded = false;
  const scenes = new Set<string>();
  if (
    !html.includes("data-composition-src") &&
    (!html.includes("data-cutroom-adjustment") ||
      !html.includes("data-color-grading"))
  )
    return { graded, scenes };
  const visit = (node: DefaultTreeAdapterTypes.Node) => {
    if ("attrs" in node) {
      if (node.attrs.some(({ name }) => name === "data-hidden")) return;
      const scene = node.attrs.find(
        ({ name }) => name === "data-composition-src",
      );
      if (scene?.value) scenes.add(scene.value);
      if (
        node.attrs.some(({ name }) => name === "data-cutroom-adjustment") &&
        node.attrs.some(({ name }) => name === "data-color-grading")
      )
        graded = true;
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
    if ("content" in node) visit(node.content);
  };
  visit(parse(html));
  return { graded, scenes };
}

/** Shared by the isolated viewer and the headless renderer. Serialized into the composition. */
export function adjustmentCapture() {
  const marker = "[data-cutroom-adjustment]";
  const attribute = "data-color-grading";
  const selector = marker + "[" + attribute + "]";
  const supported =
    typeof Reflect.get(
      CanvasRenderingContext2D.prototype,
      "drawElementImage",
    ) === "function" &&
    typeof Reflect.get(HTMLCanvasElement.prototype, "requestPaint") ===
      "function";
  const win = window as Window & {
    __hf?: {
      clipWindow?(element: Element): { start: number; end: number } | null;
      colorGrading?: {
        setGrading(id: string, grade: unknown): boolean;
        waitForActiveLuts(): Promise<number>;
      };
    };
    __player?: { getTime(): number; isPlaying(): boolean };
  };
  type CaptureCanvas = HTMLCanvasElement & { requestPaint(): void };
  type CaptureContext = CanvasRenderingContext2D & {
    drawElementImage(
      element: Element,
      x: number,
      y: number,
      width: number,
      height: number,
    ): void;
  };
  type Grade = {
    element: HTMLElement;
    root: HTMLElement;
    track: number;
    value: string;
    grading: { lut?: { src?: string; intensity?: number } };
  };
  type Band = {
    track: number;
    group: HTMLDivElement;
    output: HTMLDivElement;
    source: HTMLCanvasElement;
    context: CanvasRenderingContext2D;
    value: string | undefined;
  };
  type Scene = {
    root: HTMLElement;
    capture: CaptureCanvas;
    context: CaptureContext;
    bands: Band[];
    moved: { element: Element; slot: Comment }[];
  };
  const scenes = new Map<HTMLElement, Scene>();
  const fill =
    "position:absolute;inset:0;width:100%;height:100%;pointer-events:none";
  let grades: Grade[] | undefined;
  let animation = 0;
  let serial = 0;
  let blocked = false;
  let at = 0;
  let request:
    | {
        drawn(scene: Scene): void;
        reject(error: unknown): void;
        needsLuts: boolean;
      }
    | undefined;

  const read = () =>
    [...document.querySelectorAll<HTMLElement>(selector)].flatMap((element) => {
      if (element.closest("[data-hidden]")) return [];
      // The compiler puts mounted scene tracks inside an inner layout root.
      const root = element.parentElement?.closest<HTMLElement>(
        "[data-hf-inner-root], [data-composition-id]",
      );
      const track = Number(element.dataset.trackIndex);
      const value = element.getAttribute(attribute);
      if (!root || !Number.isFinite(track) || !value) return [];
      try {
        const grading = JSON.parse(value) as Grade["grading"] | null;
        return grading && typeof grading === "object"
          ? [{ element, root, track, value, grading }]
          : [];
      } catch (error) {
        console.warn(
          "Could not read an adjustment layer's colour grade.",
          error,
        );
        return [];
      }
    });

  const active = (time: number) => {
    const result = new Map<HTMLElement, Map<number, Grade>>();
    for (const grade of (grades ??= read())) {
      const window = win.__hf?.clipWindow?.(grade.element);
      const start = window?.start ?? Number(grade.element.dataset.start);
      const end = window?.end ?? start + Number(grade.element.dataset.duration);
      if (!(time >= start && time < end)) continue;
      let list = result.get(grade.root);
      if (!list) result.set(grade.root, (list = new Map()));
      list.set(grade.track, grade);
    }
    return result;
  };

  const move = (parent: HTMLElement, child: Element, before: Node | null) => {
    // A state-preserving move keeps the current decoded frame and running CSS animation.
    const moveBefore: unknown = Reflect.get(parent, "moveBefore");
    if (typeof moveBefore === "function")
      moveBefore.call(parent, child, before);
    else parent.insertBefore(child, before);
  };

  const companions = (element: Element) => {
    const items = [element];
    for (
      let next = element.nextElementSibling;
      next?.matches(
        "[data-hf-color-grading-canvas], [data-cutroom-video-hold], img.__render_frame__",
      );
      next = next.nextElementSibling
    )
      items.push(next);
    return items;
  };

  const restore = ({ bands, capture, moved }: Scene) => {
    for (const { element, slot } of moved) {
      if (slot.parentElement)
        for (const item of companions(element))
          move(slot.parentElement, item, slot);
      slot.remove();
    }
    for (const band of bands) {
      if (band.value !== undefined)
        win.__hf?.colorGrading?.setGrading(band.source.id, null);
      band.output.remove();
    }
    capture.remove();
  };

  function draw(scene: Scene, selected: Map<number, Grade>) {
    const { root, bands, capture, context } = scene;
    const width = Math.round(root.offsetWidth * devicePixelRatio);
    const height = Math.round(root.offsetHeight * devicePixelRatio);
    if (!width || !height)
      throw new Error("The adjustment layer has no composition size.");
    if (capture.width !== width || capture.height !== height) {
      capture.width = width;
      capture.height = height;
      capture.requestPaint();
      return false;
    }
    const renderer = win.__hf?.colorGrading;
    if (!renderer)
      throw new Error("The adjustment layer's colour renderer is unavailable.");
    let below: HTMLCanvasElement | null = null;
    let changedLut = false;
    for (const band of bands) {
      const { source, context: destination } = band;
      if (source.width !== width || source.height !== height) {
        source.width = width;
        source.height = height;
      }
      destination.clearRect(0, 0, width, height);
      if (below) destination.drawImage(below, 0, 0);
      // Keep the layout canvas transparent on screen. Its HTML paint record can
      // supply the next band without drawing the same translucent pixels twice.
      context.drawElementImage(band.group, 0, 0, width, height);
      destination.drawImage(capture, 0, 0);
      context.clearRect(0, 0, width, height);
      const grade = selected.get(band.track);
      const value = grade?.value;
      const changed = band.value !== value;
      if (value !== undefined || changed) {
        if (!renderer.setGrading(source.id, grade?.grading ?? null))
          throw new Error(
            "The adjustment layer's colour grade could not be drawn.",
          );
        band.value = value;
      }
      const graded = source.nextElementSibling;
      below = value && graded instanceof HTMLCanvasElement ? graded : source;
      if (changed && grade?.grading.lut?.src) changedLut = true;
    }
    if (changedLut) {
      if (request) request.needsLuts = true;
      else
        void renderer.waitForActiveLuts().then((pending) => {
          if (pending && capture.isConnected) capture.requestPaint();
        });
    }
    return true;
  }

  function group(root: HTMLElement, selected: Map<number, Grade>): Scene {
    const children = [...root.children].filter(
      (node) =>
        node.hasAttribute("data-track-index") &&
        !node.matches("audio, img.__render_frame__"),
    );
    const capture = document.createElement("canvas") as CaptureCanvas;
    // Chromium 155 and 156 use layoutsubtree. The finalized API uses content and drawable.
    capture.setAttribute("layoutsubtree", "");
    capture.setAttribute("content", "drawable");
    capture.setAttribute("data-hf-ignore", "");
    capture.style.cssText = fill;
    capture.width = Math.round(root.offsetWidth * devicePixelRatio);
    capture.height = Math.round(root.offsetHeight * devicePixelRatio);
    const context = capture.getContext("2d") as CaptureContext | null;
    if (!context)
      throw new Error("The adjustment layer's capture canvas is unavailable.");
    const bands: Band[] = [];
    const moved: Scene["moved"] = [];
    const tracks = [...selected.keys()].sort((a, b) => a - b);
    const highest = selected.get(tracks.at(-1)!)!.element;
    root.insertBefore(capture, highest);
    for (const track of tracks) {
      const boundary = selected.get(track)!.element;
      const group = document.createElement("div");
      group.setAttribute("drawable", "");
      group.style.cssText = fill;
      capture.append(group);
      const output = document.createElement("div");
      output.setAttribute("data-hf-ignore", "");
      output.style.cssText = fill;
      output.style.zIndex = getComputedStyle(boundary).zIndex;
      if (boundary !== highest) output.style.opacity = "0";
      root.insertBefore(output, highest);
      const source = document.createElement("canvas");
      source.id = "cutroom-adjustment-source-" + ++serial;
      source.setAttribute("data-hf-ignore", "");
      source.style.cssText = fill;
      output.append(source);
      const destination = source.getContext("2d");
      if (!destination)
        throw new Error("The adjustment layer's output canvas is unavailable.");
      bands.push({
        track,
        group,
        output,
        source,
        context: destination,
        value: undefined,
      });
      const last = bands.at(-2)?.track ?? -Infinity;
      for (const element of children) {
        const index = Number(element.getAttribute("data-track-index"));
        const region = element.matches(marker + "[data-cutroom-region]");
        if (
          index < last ||
          index > track ||
          (index === track && !region) ||
          (index === last && region)
        )
          continue;
        const slot = document.createComment("");
        element.before(slot);
        for (const item of companions(element)) move(group, item, null);
        moved.push({ element, slot });
      }
    }
    const scene = { root, capture, context, bands, moved };
    capture.addEventListener("paint", () => {
      if (!capture.isConnected) return;
      try {
        const selected = active(at).get(root);
        if (selected && draw(scene, selected)) request?.drawn(scene);
      } catch (error) {
        // Layout can change between the first request and the first paint record.
        if (request) request.reject(error);
        else console.error(error);
      }
    });
    return scene;
  }

  function prepare(time: number, required: boolean) {
    if (!supported && !required) return false;
    at = time;
    const selection = blocked
      ? new Map<HTMLElement, Map<number, Grade>>()
      : active(time);
    if (!supported && selection.size && required)
      throw new Error(
        "This Chromium build cannot capture adjustment layer grades.",
      );
    if (!supported) return false;
    for (const [root, scene] of scenes) {
      const next = selection.get(root);
      if (
        next?.size === scene.bands.length &&
        scene.bands.every(({ track }) => next.has(track))
      )
        continue;
      restore(scene);
      scenes.delete(root);
    }
    for (const [root, selected] of selection)
      if (!scenes.has(root)) scenes.set(root, group(root, selected));
    return scenes.size !== 0;
  }

  const update = (time = win.__player?.getTime() ?? 0) => {
    prepare(time, false);
    for (const { capture } of scenes.values()) capture.requestPaint();
  };

  const follow = () => {
    animation = 0;
    // During playback, a change of interval also matters over a static picture.
    if (blocked || !(grades ??= read()).length || !win.__player?.isPlaying())
      return;
    prepare(win.__player.getTime(), false);
    animation = requestAnimationFrame(follow);
  };

  return {
    get grouped() {
      return scenes.size !== 0;
    },
    update,
    changed() {
      grades = undefined;
      update();
      if (!animation) animation = requestAnimationFrame(follow);
    },
    block(value: boolean) {
      if (blocked === value) return;
      blocked = value;
      update();
      if (!blocked && !animation) animation = requestAnimationFrame(follow);
    },
    play() {
      if (!animation) animation = requestAnimationFrame(follow);
    },
    async render(time: number) {
      if (!prepare(time, true)) return;
      const frame = Promise.withResolvers<void>();
      const timer = setTimeout(
        () =>
          frame.reject(
            new Error("Chromium did not paint the adjustment layer."),
          ),
        2500,
      );
      const pending = new Set(scenes.values());
      request = {
        drawn(scene) {
          pending.delete(scene);
          if (!pending.size) frame.resolve();
        },
        reject: frame.reject,
        needsLuts: false,
      };
      try {
        for (const { capture } of scenes.values()) capture.requestPaint();
        await frame.promise;
        if (
          request.needsLuts &&
          (await win.__hf?.colorGrading?.waitForActiveLuts())
        ) {
          const selected = active(time);
          for (const scene of scenes.values()) {
            const list = selected.get(scene.root);
            if (list) draw(scene, list);
          }
        }
      } finally {
        clearTimeout(timer);
        request = undefined;
      }
    },
  };
}
