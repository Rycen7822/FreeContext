import { z } from "zod";

export const INVOCATION_POLICY = "Before parent discovery or broad reads, call gather_context once for read-only work spanning files/docs/evidence classes: code/workspace exploration; cross-document keyword/topic search; long-document facts/constraints; tracing, comparison, impact, planning, review, or diagnosis. Use in familiar workspaces/known files. After selecting FreeContext, make gather_context the next tool action; do not first list or search the repository. Skip if one bounded read/search in a known target fully answers. FreeContext never edits; parent reads decisive/edit ranges. Returns compact cited evidence plus a private full-session path.";

export const TOOL_DESCRIPTION = INVOCATION_POLICY;

export const SERVER_INSTRUCTIONS = "FreeContext exposes one read-only gather_context tool. Follow the tool description. Never send secrets/source dumps; retry only for a material gap.";

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
