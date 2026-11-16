import { z } from "zod";
import { isCompositionVariable } from "@hyperframes/core/variables";
import type { CompositionVariable } from "@hyperframes/core/variables";

export type { CompositionVariable };

/**
 * HyperFrames composition variables, as `data-composition-variables` declares them and
 * `hyperframes render --variables` overrides them. Cutroom edits the scalar kinds; font and image
 * values stay with the source.
 */
export const EDITABLE_VARIABLE_TYPES = [
  "string",
  "number",
  "color",
  "boolean",
  "enum",
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
    if (parsed.data !== variable.default) checked[id] = parsed.data;
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
    .enum(["text", "color"])
    .describe(
      "text replaces the element's words (data-var-text); color sets its text colour to var(--id)",
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

/** One composition's declarations and the overrides the preview shows. */
export const VariablesStateSchema = z.object({
  composition: z.string(),
  declarations: z.array(z.custom<CompositionVariable>(isCompositionVariable)),
  preview: VariableValuesSchema,
});
export type VariablesState = z.infer<typeof VariablesStateSchema>;
