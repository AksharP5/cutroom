import { z } from "zod";

/** One HyperFrames lint finding, as `/api/projects/:id/lint` reports it. */
export const LintFindingSchema = z.object({
  code: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  file: z.string().optional(),
  line: z.number().int().optional(),
  elementId: z.string().optional(),
  fixHint: z.string().optional(),
});
export type LintFinding = z.infer<typeof LintFindingSchema>;

export const LintReportSchema = z.object({
  findings: z.array(LintFindingSchema),
});

/** The lint answer without source snippets or selectors, errors first, with counts up front. */
export function compactLint(raw: unknown) {
  const order = { error: 0, warning: 1, info: 2 };
  const findings = LintReportSchema.parse(raw).findings.toSorted(
    (a, b) => order[a.severity] - order[b.severity],
  );
  const count = (severity: LintFinding["severity"]) =>
    findings.filter((finding) => finding.severity === severity).length;
  return { errors: count("error"), warnings: count("warning"), findings };
}
