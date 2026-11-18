import { z } from "zod";
import { isCompositionVariable } from "@hyperframes/core/variables";
import type {
  CompositionVariable,
  ImageValue,
} from "@hyperframes/core/variables";
import { inMediaTrash, localMediaPath, mediaKind } from "./media.ts";

export type { CompositionVariable };

/**
 * HyperFrames composition variables, as `data-composition-variables` declares them and
 * `hyperframes render --variables` overrides them. Cutroom edits scalars and local image paths.
 */
export const EDITABLE_VARIABLE_TYPES = [
  "string",
  "number",
  "color",
  "boolean",
  "enum",
  "image",
] as const;
export type EditableVariable = Extract<
  CompositionVariable,
  { type: (typeof EDITABLE_VARIABLE_TYPES)[number] }
>;
export const isEditable = (
  variable: CompositionVariable,
): variable is EditableVariable =>
  (EDITABLE_VARIABLE_TYPES as readonly string[]).includes(variable.type);

/** Longest text value accepted from a person or agent, unless the declaration sets a shorter one. */
export const MAX_VARIABLE_TEXT = 2000;
const MAX_LABEL = 120;
const MAX_OPTIONS = 100;

/** Becomes the CSS custom property `--{id}`, so it must be a plain identifier. */
export const VariableIdSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/,
    "Variable ids start with a letter or underscore and use letters, digits, - and _ (64 at most).",
  );

/** Six or eight hex digits, as a colour picker writes them. No other CSS reaches the document. */
export const HexColourSchema = z
  .string()
  .regex(
    /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/,
    "Colours are hex, such as #ff6600.",
  );

const ImagePathSchema = z
  .string()
  .max(MAX_VARIABLE_TEXT)
  .refine(
    (value) =>
      value === value.trim() &&
      !/^\/|[\\?#:\u0000-\u001f]/.test(value) &&
      !/%(?:2f|5c)/i.test(value) &&
      localMediaPath("index.html", value) !== null,
    "Use a relative project image path, with # and ? percent-encoded.",
  );

/** Image URLs are relative to the file declaring the variable. */
export function imageVariablePath(composition: string, value: string) {
  const path = localMediaPath(composition, value);
  if (
    path === null ||
    path.split("/").some((part) => part.startsWith(".")) ||
    inMediaTrash(path) ||
    mediaKind(path)?.kind !== "image"
  )
    throw new VariableError("Choose an image inside the project.");
  return path;
}

const imageUrl = (value: string | ImageValue) =>
  typeof value === "string" ? value : value.url;

export function variableDefaultValue(variable: EditableVariable) {
  return variable.type === "image"
    ? imageUrl(variable.default)
    : variable.default;
}

/** The declarations HyperFrames' runtime reads from one composition's attribute value. */
export function parseDeclarations(
  raw: string | undefined,
): CompositionVariable[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter(isCompositionVariable) : [];
}

export function imageDeclarationUrls(raw: string | undefined) {
  return parseDeclarations(raw).flatMap((variable) =>
    variable.type === "image" ? [imageUrl(variable.default)] : [],
  );
}

/** Rewrite only image URLs, preserving unrecognized declarations. */
export function rewriteImageDeclarationUrls(
  raw: string,
  replace: (url: string) => string,
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!Array.isArray(parsed)) return raw;
  let changed = false;
  const result = parsed.map((variable: unknown) => {
    if (!isCompositionVariable(variable) || variable.type !== "image")
      return variable;
    const previous = imageUrl(variable.default);
    const url = replace(previous);
    if (url === previous) return variable;
    changed = true;
    return {
      ...variable,
      default:
        typeof variable.default === "string"
          ? url
          : { ...variable.default, url },
    };
  });
  return changed ? JSON.stringify(result) : raw;
}

/** What a value for this declaration must be. */
export function variableValueSchema(variable: EditableVariable) {
  switch (variable.type) {
    case "string":
      return z
        .string()
        .max(
          Math.min(variable.maxLength ?? MAX_VARIABLE_TEXT, MAX_VARIABLE_TEXT),
        );
    case "number": {
      let schema = z.number().finite();
      if (typeof variable.min === "number") schema = schema.min(variable.min);
      if (typeof variable.max === "number") schema = schema.max(variable.max);
      return schema;
    }
    case "color":
      return HexColourSchema;
    case "boolean":
      return z.boolean();
    case "enum": {
      const values = variable.options.map((option) => option.value);
      return z.string().refine((value) => values.includes(value), {
        message: `Choose one of ${values.join(", ")}.`,
      });
    }
    case "image":
      return ImagePathSchema;
  }
}

export const VariableValueSchema = z.union([
  z.string().max(MAX_VARIABLE_TEXT),
  z.number().finite(),
  z.boolean(),
]);
export type VariableValue = z.infer<typeof VariableValueSchema>;
export const VariableValuesSchema = z.record(
  VariableIdSchema,
  VariableValueSchema,
);
export type VariableValues = z.infer<typeof VariableValuesSchema>;

/**
 * Checks every value against its declaration and drops those equal to the default, so an
 * override set always changes what renders. Throws with every problem named.
 */
export function checkVariableValues(
  values: VariableValues,
  declarations: readonly CompositionVariable[],
): VariableValues {
  const problems: string[] = [];
  const checked: VariableValues = {};
  for (const [id, value] of Object.entries(values)) {
    const variable = declarations.find((item) => item.id === id);
    if (!variable) {
      problems.push(`${id}: this composition declares no such variable.`);
      continue;
    }
    if (!isEditable(variable)) {
      problems.push(
        `${id}: ${variable.type} variables are set in the source, not here.`,
      );
      continue;
    }
    const parsed = variableValueSchema(variable).safeParse(value);
    if (!parsed.success) {
      problems.push(
        `${id}: ${parsed.error.issues.map((issue) => issue.message).join(" ")}`,
      );
      continue;
    }
    if (parsed.data !== variableDefaultValue(variable))
      checked[id] = parsed.data;
  }
  if (problems.length) throw new VariableError(problems.join(" "));
  return checked;
}

export class VariableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VariableError";
  }
}

const label = z.string().trim().min(1).max(MAX_LABEL);
const base = { id: VariableIdSchema, label };

/** A new declaration, as a person or agent adds it. */
export const VariableDeclarationSchema = z
  .discriminatedUnion("type", [
    z.object({
      ...base,
      type: z.literal("string"),
      default: z.string().max(MAX_VARIABLE_TEXT),
      maxLength: z.number().int().positive().max(MAX_VARIABLE_TEXT).optional(),
    }),
    z.object({
      ...base,
      type: z.literal("number"),
      default: z.number().finite(),
      min: z.number().finite().optional(),
      max: z.number().finite().optional(),
      step: z.number().finite().positive().optional(),
      unit: z.string().max(20).optional(),
    }),
    z.object({ ...base, type: z.literal("color"), default: HexColourSchema }),
    z.object({ ...base, type: z.literal("boolean"), default: z.boolean() }),
    z.object({ ...base, type: z.literal("image"), default: ImagePathSchema }),
    z.object({
      ...base,
      type: z.literal("enum"),
      default: z.string().max(MAX_VARIABLE_TEXT),
      options: z
        .array(z.object({ value: z.string().max(MAX_VARIABLE_TEXT), label }))
        .min(1)
        .max(MAX_OPTIONS),
    }),
  ])
  .superRefine((variable, context) => {
    const problem = (() => {
      if (variable.type === "string" && variable.maxLength !== undefined)
        return variable.default.length > variable.maxLength
          ? "The default is longer than maxLength."
          : null;
      if (variable.type === "number")
        return (variable.min !== undefined &&
          variable.default < variable.min) ||
          (variable.max !== undefined && variable.default > variable.max)
          ? "The default is outside min and max."
          : null;
      if (variable.type === "enum")
        return variable.options.some(
          (option) => option.value === variable.default,
        )
          ? null
          : "The default must be one of the options.";
      return null;
    })();
    if (problem) context.addIssue({ code: "custom", message: problem });
  });
export type VariableDeclaration = z.infer<typeof VariableDeclarationSchema>;

export const VariableBindingSchema = z.object({
  clipId: z.string().min(1).describe("The clip whose element takes the value"),
  to: z
    .enum(["text", "color", "image"])
    .describe(
      "text replaces the element's words, color sets its inline text colour, and image binds an image clip's source",
    ),
});
export type VariableBinding = z.infer<typeof VariableBindingSchema>;

const composition = z
  .string()
  .min(1)
  .default("index.html")
  .describe(
    "The composition file, such as compositions/intro.html; index.html when omitted",
  );

export const VariablesPreviewSchema = z.object({
  composition,
  values: VariableValuesSchema.describe(
    "The whole override set, by variable id. Values equal to a default are dropped; {} returns to the defaults",
  ),
});
export const VariableDefaultSchema = z.object({
  composition,
  id: VariableIdSchema,
  value: VariableValueSchema,
});
export const VariableDeclareSchema = z.object({
  composition,
  variable: VariableDeclarationSchema,
  bind: VariableBindingSchema.optional(),
});

export const VariableBindSchema = z.object({
  composition,
  id: VariableIdSchema,
  bind: VariableBindingSchema,
});

/** One composition's declarations and the overrides the preview shows. */
export const VariablesStateSchema = z.object({
  composition: z.string(),
  declarations: z.array(z.custom<CompositionVariable>(isCompositionVariable)),
  preview: VariableValuesSchema,
});
export type VariablesState = z.infer<typeof VariablesStateSchema>;
