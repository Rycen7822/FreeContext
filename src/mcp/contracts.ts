import { z } from "zod";

export const INVOCATION_POLICY = "Use gather_context for read-only work across files/documents or evidence classes; code/workspace exploration; cross-document keyword/topic search; key facts/constraints from long documents; tracing, comparison, impact mapping, planning, review, or diagnosis; or tasks needing multiple exploratory reads. Use it in familiar workspaces and with known candidates. Skip only when one bounded read or direct search in one known target fully answers. FreeContext never edits; parent reads exact edit ranges.";

export const SERVER_INSTRUCTIONS = "FreeContext has one read-only context-gathering tool. Follow gather_context's description. Never send credentials or source dumps, repeat a successful request, or make a follow-up unless the prior result names a material gap.";

export const VISIBLE_RESULT_LIMITS = Object.freeze({
  evidence: 8,
  gaps: 4,
  summaryCharacters: 1_200,
  detailCharacters: 300,
});

export const VISIBLE_TRUNCATION_GAP = "Visible result truncated; inspect sessionFile for the complete capture.";

export const GatherContextInputSchema = z.object({
  query: z.string().trim().min(1).max(16_000),
  workspace: z.string().trim().min(1),
}).strict();

export const GatherContextEvidenceSchema = z.object({
  path: z.string(),
  start: z.number().int().positive(),
  end: z.number().int().positive(),
  reason: z.string().max(VISIBLE_RESULT_LIMITS.detailCharacters),
}).strict().refine(({ start, end }) => end >= start, { message: "end must be greater than or equal to start" });

export const GatherContextErrorSchema = z.object({
  code: z.string(),
  message: z.string().max(VISIBLE_RESULT_LIMITS.detailCharacters),
}).strict();

export const GatherContextOutputSchema = z.object({
  status: z.enum(["completed", "partial", "no_evidence", "failed"]),
  summary: z.string().max(VISIBLE_RESULT_LIMITS.summaryCharacters),
  evidence: z.array(GatherContextEvidenceSchema).max(VISIBLE_RESULT_LIMITS.evidence),
  gaps: z.array(z.string().max(VISIBLE_RESULT_LIMITS.detailCharacters)).max(VISIBLE_RESULT_LIMITS.gaps),
  sessionFile: z.string().nullable(),
  error: GatherContextErrorSchema.nullable(),
}).strict();

export type GatherContextInput = z.infer<typeof GatherContextInputSchema>;
export type GatherContextEvidence = z.infer<typeof GatherContextEvidenceSchema>;
export type GatherContextError = z.infer<typeof GatherContextErrorSchema>;
export type GatherContextOutput = z.infer<typeof GatherContextOutputSchema>;
export type FreeContextToolStatus = GatherContextOutput["status"];

export function renderGatherContextText(result: Readonly<GatherContextOutput>): string {
  const session = result.sessionFile ?? "unavailable";
  return `Status: ${result.status}\nValidated spans: ${result.evidence.length}\nGaps: ${result.gaps.length}\nFull session: ${session}`;
}
