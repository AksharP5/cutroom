import { Hono } from "hono";
import { z } from "zod";
import { fullAncestor } from "acorn-walk";
import { parseHTML } from "linkedom";
import { parseGsapScript } from "@hyperframes/parsers/gsap-parser";
import type { GsapAnimation } from "@hyperframes/parsers/gsap-parser";
import { parseGsapScriptAcornForWrite } from "@hyperframes/parsers/gsap-parser-acorn";
import { updateAnimationInScript } from "@hyperframes/parsers/gsap-writer-acorn";
import {
  applyFileMutations,
  fileContentVersion,
} from "@hyperframes/studio-server";
import { HttpError } from "../../shared/errors";
import { AGENT_HEADER } from "../../shared/review";
import { MotionReadSchema, MotionUpdateSchema } from "../../shared/motion";
import type { MotionSnapshot, MotionUpdate } from "../../shared/motion";
import { emptyTimelineSettings } from "../../shared/timeline/schema";
import type { TimelineSettings } from "../../shared/timeline/schema";
import { posix } from "node:path";
import { randomUUID } from "node:crypto";
import {
  compositionScope,
  parseComposition,
  scopeElements,
} from "../timeline/composition";
import { projectMutationGuard } from "./authorization";
import { projectWritePath } from "./path";
import { historyWho, parseInput } from "./routes";
import { readSource } from "./store";
import type { ProjectStore } from "./store";
import type { ReviewService } from "./review";

// A typed projection of the public parser's AST. No parser reaches the browser.
const SyntaxSchema = z.object({
  type: z.string(),
  start: z.number(),
  end: z.number(),
  name: z.string().optional(),
  kind: z.string().optional(),
  operator: z.string().optional(),
  computed: z.boolean().optional(),
  method: z.boolean().optional(),
  shorthand: z.boolean().optional(),
  get value() {
    return z
      .union([z.string(), z.number(), z.boolean(), z.null(), SyntaxSchema])
      .optional();
  },
  get body() {
    return z.union([z.array(SyntaxSchema), SyntaxSchema]).optional();
  },
  get declarations() {
    return z.array(SyntaxSchema).optional();
  },
  get arguments() {
    return z.array(SyntaxSchema).optional();
  },
  get properties() {
    return z.array(SyntaxSchema).optional();
  },
  get id() {
    return SyntaxSchema.nullish();
  },
  get init() {
    return SyntaxSchema.optional();
  },
  get callee() {
    return SyntaxSchema.optional();
  },
  get object() {
    return SyntaxSchema.optional();
  },
  get property() {
    return SyntaxSchema.optional();
  },
  get key() {
    return SyntaxSchema.optional();
  },
  get expression() {
    return z.union([SyntaxSchema, z.boolean()]).optional();
  },
  get argument() {
    return SyntaxSchema.optional();
  },
  get left() {
    return SyntaxSchema.optional();
  },
  get right() {
    return SyntaxSchema.optional();
  },
});
type Syntax = z.infer<typeof SyntaxSchema>;

const identifier = (node: Syntax | null | undefined, name: string) =>
  node?.type === "Identifier" && node.name === name;
const member = (node: Syntax | undefined, object: string, property: string) =>
  node?.type === "MemberExpression" &&
  !node.computed &&
  identifier(node.object, object) &&
  identifier(node.property, property);
const number = (node: Syntax | undefined): number | null => {
  if (
    node?.type === "Literal" &&
    typeof node.value === "number" &&
    Number.isFinite(node.value)
  )
    return node.value;
  if (
    node?.type === "UnaryExpression" &&
    (node.operator === "-" || node.operator === "+") &&
    node.argument?.type === "Literal" &&
    typeof node.argument.value === "number"
  )
    return node.operator === "-" ? -node.argument.value : node.argument.value;
  return null;
};
const string = (node: Syntax | undefined) =>
  node?.type === "Literal" && typeof node.value === "string"
    ? node.value
    : null;

/** Only ordinary own keys: spreads, accessors and duplicate/computed keys have no single field to edit. */
function fields(node: Syntax | undefined): Map<string, Syntax> | null {
  if (node?.type !== "ObjectExpression") return null;
  const result = new Map<string, Syntax>();
  for (const property of node.properties ?? []) {
    const key = property.key?.name ?? string(property.key);
    const value = property.value;
    if (
      property.type !== "Property" ||
      property.computed ||
      property.method ||
      property.shorthand ||
      property.kind !== "init" ||
      !key ||
      !value ||
      typeof value !== "object" ||
      result.has(key)
    )
      return null;
    result.set(key, value);
  }
  return result;
}

const SOURCE_ONLY =
  "Only direct literal calls on one top-level GSAP timeline are editable. Helpers, loops, aliases and other timeline uses stay in Source.";

/** Prove ownership with a positive grammar, rather than trusting the parser's computed expansion. */
function timelineReason(
  raw: NonNullable<ReturnType<typeof parseGsapScriptAcornForWrite>>,
  ast: Syntax,
  rootId: string,
) {
  if (!raw.hasTimeline)
    return raw.located.some((entry) => !entry.animation.global)
      ? SOURCE_ONLY
      : null;
  if (!Array.isArray(ast.body)) return SOURCE_ONLY;
  const allowed = new Set<number>();
  let declarations = 0;
  for (const statement of ast.body) {
    if (
      statement.type === "VariableDeclaration" &&
      statement.declarations?.length === 1
    ) {
      const declaration = statement.declarations[0]!;
      if (
        identifier(declaration.id, raw.timelineVar) &&
        declaration.init?.type === "CallExpression" &&
        member(declaration.init.callee, "gsap", "timeline")
      ) {
        declarations++;
        allowed.add(declaration.id!.start);
      }
    }
    if (statement.type !== "ExpressionStatement") continue;
    if (!statement.expression || typeof statement.expression !== "object")
      continue;
    let call: Syntax | undefined = statement.expression;
    // Registration is the only non-tween use supported by this slice.
    if (
      call?.type === "AssignmentExpression" &&
      call.operator === "=" &&
      identifier(call.right, raw.timelineVar) &&
      call.left?.type === "MemberExpression" &&
      member(call.left.object, "window", "__timelines") &&
      (call.left.computed
        ? string(call.left.property) === rootId
        : identifier(call.left.property, rootId))
    ) {
      allowed.add(call.right!.start);
      continue;
    }
    while (
      call?.type === "CallExpression" &&
      call.callee?.type === "MemberExpression" &&
      !call.callee.computed &&
      ["to", "from", "fromTo", "set"].includes(call.callee.property?.name ?? "")
    ) {
      const receiver: Syntax | undefined = call.callee.object;
      if (identifier(receiver, raw.timelineVar)) allowed.add(receiver!.start);
      call = receiver;
    }
  }
  if (declarations !== 1) return SOURCE_ONLY;
  let unsafe = false;
  fullAncestor(raw.ast, (node) => {
    if (node.type === "Identifier") {
      const id = z.object({ name: z.string() }).parse(node);
      if (id.name === raw.timelineVar && !allowed.has(node.start))
        unsafe = true;
    }
  });
  return unsafe ? SOURCE_ONLY : null;
}

function parseScript(code: string, start: number, rootId: string) {
  const raw = parseGsapScriptAcornForWrite(code);
  if (!raw) return null;
  const parsed = parseGsapScript(code);
  const ast = SyntaxSchema.safeParse(raw.ast);
  if (!ast.success) return null;
  let reason =
    parsed.multipleTimelines || parsed.unsupportedTimelinePattern
      ? "Multiple or unresolved GSAP timelines stay in Source."
      : timelineReason(raw, ast.data, rootId);
  const gsapReferences = new Set<number>();
  const references = new Set<string>();
  fullAncestor(raw.ast, (node) => {
    if (node.type !== "CallExpression") return;
    const call = SyntaxSchema.parse(node);
    if (
      member(call.callee, "gsap", "timeline") ||
      member(call.callee, "gsap", "set")
    )
      gsapReferences.add(call.callee!.object!.start);
    if (
      ["to", "from", "fromTo"].some((method) =>
        member(call.callee, "gsap", method),
      )
    )
      reason ??=
        "Standalone gsap.to/from/fromTo calls stay in Source. Use a named timeline for editable motion.";
    if (member(call.callee, "gsap", "timeline") && !raw.hasTimeline)
      reason ??= SOURCE_ONLY;
  });
  fullAncestor(raw.ast, (node) => {
    if (node.type !== "Identifier") return;
    const { name } = z.object({ name: z.string() }).parse(node);
    references.add(name);
    if (name === "gsap" && !gsapReferences.has(node.start))
      reason ??=
        "GSAP aliases, shadowed bindings and other GSAP uses stay in Source.";
  });
  const located = raw.located.map((entry) => ({
    ...entry,
    node: SyntaxSchema.parse(entry.call.node),
    ancestors: z
      .array(z.object({ type: z.string() }))
      .parse(entry.call.ancestors),
  }));
  return { code, start, raw, parsed, reason, located, references };
}

type Script = NonNullable<ReturnType<typeof parseScript>>;
type Entry = Script["located"][number];

function tweenFields(entry: Entry) {
  const args = entry.node.arguments ?? [];
  return {
    from:
      entry.animation.method === "fromTo"
        ? fields(args[1])
        : entry.animation.method === "from"
          ? fields(args[1])
          : new Map<string, Syntax>(),
    to:
      entry.animation.method === "from"
        ? new Map<string, Syntax>()
        : fields(args[entry.animation.method === "fromTo" ? 2 : 1]),
    vars: fields(args[entry.animation.method === "fromTo" ? 2 : 1]),
    position: args[entry.animation.method === "fromTo" ? 3 : 2],
  };
}

function entryReason(script: Script, entry: Entry) {
  if (script.reason) return script.reason;
  if (
    entry.ancestors.some(
      (node) =>
        ![
          "Program",
          "ExpressionStatement",
          "CallExpression",
          "MemberExpression",
        ].includes(node.type),
    )
  )
    return SOURCE_ONLY;
  if (string(entry.node.arguments?.[0]) === null)
    return "Computed targets stay in Source.";
  const parsed = script.parsed.animations.find((item) => item.id === entry.id);
  if (
    !parsed ||
    (parsed.provenance && parsed.provenance.kind !== "literal") ||
    parsed.targetSelector !== entry.animation.targetSelector
  )
    return SOURCE_ONLY;
  const props = tweenFields(entry);
  if (!props.from || !props.to || !props.vars)
    return "Spread, computed, duplicate or indirect vars stay in Source.";
  if (props.vars.has("keyframes") || props.vars.has("motionPath"))
    return "Keyframe and path tweens stay in Source.";
  return null;
}

/** Source and identities come from this one read. Templates use the timeline projection's scope. */
function inspect(
  content: string,
  version: string,
  composition: string,
  clipId: string,
  settings: TimelineSettings,
) {
  const projection = parseComposition(content, settings, {
    scope: compositionScope(composition),
  });
  const element = projection.elements.get(clipId);
  if (!element)
    throw new HttpError(404, `No clip ${clipId} in ${composition}.`);
  const all = scopeElements(projection.roots, projection.scope);
  const lockedTracks = new Set(
    projection.timeline.tracks
      .filter((track) => track.locked)
      .map((track) => track.index),
  );
  const lockedElements = projection.timeline.clips
    .filter((clip) => lockedTracks.has(clip.track))
    .map((clip) => projection.elements.get(clip.id)!)
    .toSorted((a, b) => a.openEnd - b.openEnd);
  // Tag parser-located owners only in the query copy. This maps even generated clip IDs to
  // their real DOM nodes, without writing IDs or markers into the composition source.
  const lockAttribute = `data-cutroom-motion-lock-${randomUUID()}`;
  let cursor = 0;
  const queryContent =
    lockedElements
      .map((owner) => {
        const at = owner.openEnd - (content[owner.openEnd - 2] === "/" ? 2 : 1);
        const before = content.slice(cursor, at);
        cursor = at;
        return `${before} ${lockAttribute}`;
      })
      .join("") + content.slice(cursor);
  const { document } = parseHTML(queryContent);
  const queryRoot =
    projection.scope === "sub-composition"
      ? (document.querySelector("template")?.content ?? document)
      : document;
  const selected = [...queryRoot.querySelectorAll("[id]")].filter(
    (node) => node.id === element.attrs.id,
  );
  const snapshot: MotionSnapshot = {
    composition,
    clipId,
    version,
    reason: null,
    notices: [],
    animations: [],
  };
  if (!element.attrs.id || selected.length !== 1)
    snapshot.reason =
      "Motion needs a unique authored element id in this composition. Use Source for this clip.";
  const scripts: Script[] = [];
  for (const script of all.filter((node) => node.tag === "script")) {
    if (script.attrs.src) {
      snapshot.notices.push("External JavaScript stays in Source.");
      continue;
    }
    if (
      script.attrs.type &&
      !["text/javascript", "application/javascript", "module"].includes(
        script.attrs.type,
      )
    )
      continue;
    const end = projection.nodes[script.index]!.own.at(-1)?.[0];
    if (end === undefined || end < script.openEnd) continue;
    const code = content.slice(script.openEnd, end);
    if (!code.trim()) continue;
    const parsed = parseScript(
      code,
      script.openEnd,
      projection.root.attrs["data-composition-id"]!,
    );
    if (!parsed) {
      snapshot.notices.push(
        "An inline script could not be inspected. Its motion stays in Source.",
      );
      snapshot.reason ??=
        "An inline script could not be inspected safely. Use Source.";
      continue;
    }
    scripts.push(parsed);
  }
  if (scripts.filter((script) => script.raw.hasTimeline).length > 1)
    snapshot.reason ??=
      "Multiple GSAP timelines in this composition stay in Source.";
  for (const owner of scripts.filter((script) => script.raw.hasTimeline)) {
    if (
      scripts.some(
        (script) =>
          script !== owner && script.references.has(owner.raw.timelineVar),
      )
    )
      snapshot.reason ??=
        "Timeline references span multiple scripts. Edit this motion in Source.";
  }
  const entries = new Map<string, { script: Script; entry: Entry }>();
  for (const script of scripts) {
    if (script.reason) snapshot.notices.push(script.reason);
    snapshot.reason ??= script.reason;
    if (script.parsed.animations.length !== script.located.length)
      snapshot.notices.push("Computed/helper motion stays in Source.");
    for (const entry of script.located) {
      const animation = entry.animation;
      let targets: Element[] = [];
      let reason = entryReason(script, entry);
      try {
        targets = [...queryRoot.querySelectorAll(animation.targetSelector)];
      } catch {
        reason ??= "This selector cannot be resolved statically. Use Source.";
      }
      const unresolved = string(entry.node.arguments?.[0]) === null;
      if (!targets.includes(selected[0]!) && !unresolved) continue;
      if (targets.some((target) => target.closest(`[${lockAttribute}]`)))
        reason ??= "This motion targets a locked track.";
      const id = `${script.start}:${entry.id}`;
      const props = tweenFields(entry);
      const sourceOnly: string[] = [];
      const numeric = (values: Map<string, Syntax> | null, side: string) =>
        Object.fromEntries(
          [...(values ?? [])].flatMap(([name, node]) => {
            const parsed = number(node);
            if (
              parsed !== null &&
              name in
                (side === "from" && animation.method === "fromTo"
                  ? (animation.fromProperties ?? {})
                  : animation.properties)
            )
              return [[name, parsed]];
            sourceOnly.push(`${side}.${name}`);
            return [];
          }),
        );
      const from = numeric(props.from, "from");
      const to = numeric(props.to, "to");
      // Timing and ease have their own fields, not property controls.
      const sourceFields = sourceOnly.filter(
        (name) => !/^(from|to)\.(duration|ease)$/.test(name),
      );
      snapshot.animations.push({
        id,
        selector: unresolved ? "Unresolved target" : animation.targetSelector,
        method: animation.method,
        targets: targets.map((node) =>
          node.id ? `#${node.id}` : `${node.localName} (no id)`,
        ),
        reason,
        from,
        to,
        position: animation.global ? null : number(props.position),
        duration:
          animation.method === "set"
            ? null
            : number(props.vars?.get("duration")),
        ease: string(props.vars?.get("ease")),
        sourceOnly: sourceFields,
      });
      entries.set(id, { script, entry });
    }
  }
  snapshot.notices = [...new Set(snapshot.notices)];
  return { snapshot, entries, projection };
}

function changeSource(
  content: string,
  inspected: ReturnType<typeof inspect>,
  input: MotionUpdate,
) {
  const shown = inspected.snapshot.animations.find(
    (entry) => entry.id === input.animationId,
  );
  const found = inspected.entries.get(input.animationId);
  const reason = inspected.snapshot.reason ?? shown?.reason;
  if (reason) throw new HttpError(422, reason);
  if (!shown || !found)
    throw new HttpError(404, "That motion no longer exists. Inspect it again.");
  const { script, entry } = found;
  const props = tweenFields(entry);
  const change = input.change;
  let original: Syntax | undefined;
  let updates: Partial<GsapAnimation>;
  if (change.kind === "property") {
    if (!(change.name in shown[change.side]))
      throw new HttpError(
        422,
        "Only existing numeric motion properties are editable.",
      );
    original = props[change.side]?.get(change.name);
    const from = entry.animation.method === "fromTo" && change.side === "from";
    updates = from
      ? {
          fromProperties: {
            ...entry.animation.fromProperties,
            [change.name]: change.value,
          },
        }
      : {
          properties: {
            ...entry.animation.properties,
            [change.name]: change.value,
          },
        };
  } else {
    if (shown[change.kind] === null)
      throw new HttpError(
        422,
        "This motion field is not an authored literal. Use Source.",
      );
    // The writer supports __raw internally; an ease here is always a string, never code.
    if (change.kind === "ease" && change.value.startsWith("__raw:"))
      throw new HttpError(422, "Use a literal GSAP ease name.");
    original =
      change.kind === "position"
        ? props.position
        : props.vars?.get(change.kind);
    updates = { [change.kind]: change.value };
  }
  if (!original)
    throw new HttpError(
      422,
      "This motion field cannot be located. Use Source.",
    );
  // A standalone set is passed alone so the public writer cannot relocate it around a timeline.
  const writerSource = entry.animation.global
    ? script.code.slice(entry.node.start, entry.node.end)
    : script.code;
  const writerEntries = entry.animation.global
    ? parseGsapScriptAcornForWrite(writerSource)?.located
    : script.located;
  const ordinal = entry.animation.global ? 0 : script.located.indexOf(entry);
  const writerId = writerEntries?.[ordinal]?.id;
  if (!writerId)
    throw new HttpError(
      422,
      "This motion cannot be located by the public writer. Use Source.",
    );
  const rewritten = updateAnimationInScript(writerSource, writerId, updates);
  const written = parseScript(
    rewritten,
    script.start,
    inspected.projection.root.attrs["data-composition-id"]!,
  );
  // Position is part of a parser ID. The writer edits exactly one call without adding calls.
  const changed =
    written?.located.length === writerEntries?.length
      ? written?.located[ordinal]
      : undefined;
  const nextProps = changed && tweenFields(changed);
  const literal =
    change.kind === "property"
      ? nextProps?.[change.side]?.get(change.name)
      : change.kind === "position"
        ? nextProps?.position
        : nextProps?.vars?.get(change.kind);
  if (
    !literal ||
    (change.kind === "ease" ? string(literal) : number(literal)) !==
      change.value
  )
    throw new HttpError(
      422,
      "The public GSAP writer could not preserve this edit. Use Source.",
    );
  // The public writer rebuilds vars objects (and can move global sets). Copy only the requested
  // literal back, leaving every other byte, including callbacks, comments and quotes, untouched.
  const replacement = rewritten.slice(literal.start, literal.end);
  if (/<\/script/i.test(replacement))
    throw new HttpError(422, "An ease cannot close its script element.");
  return (
    content.slice(0, script.start + original.start) +
    replacement +
    content.slice(script.start + original.end)
  );
}

export function createMotionRoutes(
  store: ProjectStore,
  reviews: ReviewService,
) {
  const api = new Hono();
  api.use("/projects/:id/*", projectMutationGuard(reviews));
  const path = (value: string) => {
    const normalized = posix.normalize(value.replaceAll("\\", "/"));
    if (
      normalized.startsWith("/") ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      !/\.html?$/i.test(normalized)
    )
      throw new HttpError(
        400,
        "Motion is edited in an HTML composition inside the project.",
      );
    return normalized;
  };
  api.get("/projects/:id/motion", async (c) => {
    const input = parseInput(MotionReadSchema, c.req.query());
    const project = await store.get(c.req.param("id"));
    const composition = path(input.composition);
    const source = await readSource(project, composition);
    const settings =
      (await store.document(project)).timelines[composition] ??
      emptyTimelineSettings();
    return c.json(
      inspect(
        source.content,
        source.version,
        composition,
        input.clipId,
        settings,
      ).snapshot,
    );
  });
  api.post("/projects/:id/motion", async (c) => {
    const input = parseInput(MotionUpdateSchema, await c.req.json());
    const project = await store.get(c.req.param("id"));
    const composition = path(input.composition);
    const result = await reviews.editComposition(
      project,
      composition,
      c.req.header(AGENT_HEADER),
      () =>
        store.mutate(
          project,
          `Edit ${input.clipId} motion`,
          async () => {
            const source = await readSource(project, composition);
            if (source.version !== input.expectedVersion)
              throw new HttpError(
                409,
                "The source changed. Inspect motion again before editing.",
              );
            const settings =
              (await store.document(project)).timelines[composition] ??
              emptyTimelineSettings();
            const inspected = inspect(
              source.content,
              source.version,
              composition,
              input.clipId,
              settings,
            );
            const after = changeSource(source.content, inspected, input);
            applyFileMutations(project.path, [
              {
                sourceFile: composition,
                absPath: await projectWritePath(project, composition),
                before: source.content,
                after,
                expectedVersion: input.expectedVersion,
              },
            ]);
            return inspect(
              after,
              fileContentVersion(after),
              composition,
              input.clipId,
              settings,
            ).snapshot;
          },
          historyWho(reviews, c, project),
        ),
    );
    return c.json(result);
  });
  return api;
}
