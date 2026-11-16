import {
  HF_AUDIO_FX_CHAIN_VERSION,
  HF_AUDIO_FX_IDS,
  defaultAudioFxParams,
  getAudioFxDef,
  mintAudioFxNodeId,
  normalizeAudioFxParams,
  parseAudioFxChain,
  serializeAudioFxChain,
} from "@hyperframes/core/audio-fx";
import type {
  HfAudioFxChain,
  HfAudioFxNode,
  HfAudioFxParamValues,
} from "@hyperframes/core/audio-fx";
import {
  HF_AUDIO_FX_PRESET_IDS,
  getAudioFxPreset,
} from "@hyperframes/core/audio-fx-presets";
import { z } from "zod";

/** A chain this long is far past any rack a person builds, and keeps a document's graph bounded. */
export const MAX_FX_NODES = 32;

const fxType = z
  .string()
  .refine((type) => getAudioFxDef(type) !== undefined, {
    message: `Unknown effect. Use one of: ${HF_AUDIO_FX_IDS.join(", ")}.`,
  })
  .describe(`Effect: ${HF_AUDIO_FX_IDS.join(", ")}`);

/** Node ids address automation lanes as `fx.<id>.<param>`, so they stay plain words. */
const fxId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,40}$/, "Effect ids are letters, digits, - and _.");

const fxParams = z
  .record(z.string(), z.union([z.number(), z.string()]))
  .describe(
    "Parameters in the effect's own units (dB, Hz, ms, ratio); numbers within the effect's range, choices from its options",
  );

/** Every parameter is one the effect has: a number within its range, or one of its options. */
function checkParams(
  type: string,
  params: Record<string, number | string>,
  context: z.RefinementCtx,
) {
  const def = getAudioFxDef(type);
  if (!def) return;
  for (const [key, value] of Object.entries(params)) {
    const param = def.params.find((each) => each.key === key);
    const problem = !param
      ? `${def.label} has no parameter "${key}". It has ${def.params.map((each) => each.key).join(", ")}.`
      : param.kind === "number"
        ? typeof value !== "number" || value < param.min || value > param.max
          ? `${def.label} ${param.label} goes from ${param.min} to ${param.max}${param.unit && ` ${param.unit}`}.`
          : null
        : !param.options.some((option) => option.value === value)
          ? `${def.label} ${param.label} is one of ${param.options.map((option) => option.value).join(", ")}.`
          : null;
    if (problem)
      context.addIssue({ code: "custom", message: problem, path: ["params"] });
  }
}

/** One effect in a clip's or a track's chain, as the timeline reads it. */
export const FxNodeSchema = z
  .object({
    id: z.string().min(1),
    type: fxType,
    enabled: z.boolean(),
    label: z.string().max(200).nullable(),
    /** The preset that added this node, which the rack groups it under. */
    preset: z.string().nullable(),
    params: fxParams,
  })
  .superRefine(({ type, params }, context) =>
    checkParams(type, params, context),
  );
export type FxNode = z.infer<typeof FxNodeSchema>;

/** An effect or a preset as a command lists it. */
export const FxInputSchema = z.union([
  z
    .object({
      preset: z
        .string()
        .refine((id) => getAudioFxPreset(id) !== undefined, {
          message: `Unknown preset. Use one of: ${HF_AUDIO_FX_PRESET_IDS.join(", ")}.`,
        })
        .describe(`Preset: ${HF_AUDIO_FX_PRESET_IDS.join(", ")}`),
    })
    .strict()
    .describe("Adds the preset's effects, in order, under its name"),
  z
    .object({
      id: fxId
        .optional()
        .describe(
          "Keep an existing effect: omitted fields keep its values. New effects get the next free n1, n2, ...",
        ),
      type: fxType,
      enabled: z.boolean().optional().describe("False bypasses the effect"),
      label: z.string().max(200).nullable().optional(),
      params: fxParams.optional(),
    })
    .strict()
    .superRefine(({ type, params }, context) =>
      checkParams(type, params ?? {}, context),
    ),
]);
export type FxInput = z.infer<typeof FxInputSchema>;

export const FxChainInputSchema = z
  .array(FxInputSchema)
  .max(MAX_FX_NODES)
  .describe(
    "The whole effect chain in signal order; [] removes every effect. Each entry is an effect {type, params, enabled, id} or a preset {preset}",
  );

export const asHfChain = (nodes: readonly FxNode[]): HfAudioFxChain => ({
  version: HF_AUDIO_FX_CHAIN_VERSION,
  nodes: nodes.map((node) => ({ type: node.type, id: node.id })),
});

/** A node as a command would send it back: every value it has. */
export const fxInput = (node: FxNode): FxInput => ({
  id: node.id,
  type: node.type,
  enabled: node.enabled,
  label: node.label,
  params: node.params,
});

/**
 * A `data-fx-chain` attribute as timeline effects. Nodes written without an id get the next free
 * one, so every effect can be addressed; an unreadable chain throws.
 */
export function readFxChain(attribute: string | undefined): FxNode[] {
  if (!attribute) return [];
  const chain = parseAudioFxChain(attribute);
  const named: HfAudioFxNode[] = [];
  for (const node of chain.nodes)
    named.push({
      ...node,
      id:
        node.id ??
        mintAudioFxNodeId({ ...chain, nodes: [...chain.nodes, ...named] }),
    });
  return named.map((node) => ({
    id: node.id!,
    type: node.type,
    enabled: node.enabled !== false,
    label: node.label ?? null,
    preset: node.fromPreset ?? null,
    params: normalizeAudioFxParams(node.type, node.params),
  }));
}

/**
 * Timeline effects as a `data-fx-chain` attribute, or null for none. Nodes keep what Cutroom does
 * not edit from the chain they replace, by id: a carve's or an EQ's marks, and a preset's amount.
 */
export function writeFxChain(
  nodes: readonly FxNode[],
  attribute?: string,
): string | null {
  if (!nodes.length) return null;
  let previous: HfAudioFxNode[] = [];
  try {
    previous = attribute ? parseAudioFxChain(attribute).nodes : [];
  } catch {
    // An unreadable chain has nothing worth keeping; the timeline's nodes replace it.
  }
  return serializeAudioFxChain({
    version: HF_AUDIO_FX_CHAIN_VERSION,
    nodes: nodes.map((node): HfAudioFxNode => {
      const old = previous.find(
        (each) => each.id === node.id && each.type === node.type,
      );
      return {
        ...(old?.fromCarve && { fromCarve: true }),
        ...(old?.fromEq && { fromEq: old.fromEq }),
        ...(old?.fromLeveller && { fromLeveller: true }),
        ...(old?.presetAmount !== undefined &&
          node.preset && { presetAmount: old.presetAmount }),
        type: node.type,
        id: node.id,
        ...(node.label && { label: node.label }),
        ...(node.preset && { fromPreset: node.preset }),
        ...(!node.enabled && { enabled: false }),
        params: node.params,
      };
    }),
  });
}

/** A node as agents read it: parameters left at their defaults, and the defaults of the rest, are omitted. */
export function compactFxNode(node: FxNode) {
  const defaults: HfAudioFxParamValues = defaultAudioFxParams(node.type);
  const params = Object.fromEntries(
    Object.entries(node.params).filter(
      ([key, value]) => defaults[key] !== value,
    ),
  );
  return {
    id: node.id,
    type: node.type,
    ...(!node.enabled && { enabled: false }),
    ...(node.label && { label: node.label }),
    ...(node.preset && { preset: node.preset }),
    ...(Object.keys(params).length && { params }),
  };
}

/** The master bus effect that carries the mix's loudness normalization. */
export const LOUDNESS_FX_ID = "loudness";

/**
 * The master chain with its loudness gain set so a mix measured at `lufs` reaches `target`. The
 * measured mix already includes the current loudness gain, so the change adds to it; gain stays
 * within the gain effect's range.
 */
export function mixLoudnessFx(
  masterFx: readonly FxNode[],
  lufs: number,
  target: number,
): FxInput[] {
  const current = masterFx.find((node) => node.id === LOUDNESS_FX_ID);
  const before = current?.enabled ? Number(current.params.gain ?? 0) : 0;
  const gain =
    Math.round(Math.min(12, Math.max(-60, before + target - lufs)) * 10) / 10;
  return [
    ...masterFx.filter((node) => node.id !== LOUDNESS_FX_ID).map(fxInput),
    {
      id: LOUDNESS_FX_ID,
      type: "gain",
      label: "Loudness",
      enabled: true,
      params: { gain },
    },
  ];
}
