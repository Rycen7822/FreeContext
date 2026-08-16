import { z } from "zod";
import path from "node:path";

export type FreeContextEligibilityOutcome = "call" | "direct_read" | "exact_probe";

export interface FreeContextEligibilityGate {
  readonly order: 1 | 2 | 3 | 4;
  readonly id: "complex_scope" | "single_known_implementation" | "exact_candidate_probe" | "candidate_count";
  readonly outcome: FreeContextEligibilityOutcome | "candidate_dependent";
  readonly instruction: string;
}

export const FREECONTEXT_ELIGIBILITY_POLICY = Object.freeze({
  id: "freecontext-eligibility-v1",
  toolName: "gather_context",
  gates: Object.freeze([
    Object.freeze({
      order: 1,
      id: "complex_scope",
      outcome: "call",
      instruction: "Before any repository probe, call for two or more required evidence roles, a cross-module call chain, two or more jointly constraining configs, cross-document synthesis, long-document multi-fact extraction, or source-bound planning, review, or diagnosis.",
    }),
    Object.freeze({
      order: 2,
      id: "single_known_implementation",
      outcome: "direct_read",
      instruction: "Skip only when the required scope is implementation-only, a stack reference or path-qualified symbol is known, and one bounded read is sufficient.",
    }),
    Object.freeze({
      order: 3,
      id: "exact_candidate_probe",
      outcome: "exact_probe",
      instruction: "Otherwise make at most one exact path or symbol probe, return at most six relative candidates, and do not read source text.",
    }),
    Object.freeze({
      order: 4,
      id: "candidate_count",
      outcome: "candidate_dependent",
      instruction: "Call for zero or three to six candidates; directly read one or two exact candidates.",
    }),
  ] satisfies readonly FreeContextEligibilityGate[]),
  invariants: Object.freeze([
    "Repository familiarity, known files, and known keywords never weaken cross-document, cross-section, impact-map, or multi-role eligibility.",
    "FreeContext is read-only and never performs edits, tests, Git, package management, web access, or credential work.",
    "Returned summaries are not repository reads; first batch reads all evidence including nextAction with no search; afterward partial permits one targeted named-gap search batch and ready none.",
  ]),
});

export const FREECONTEXT_HOST_ROUTE_METADATA = Object.freeze({
  policyId: FREECONTEXT_ELIGIBILITY_POLICY.id,
  toolName: FREECONTEXT_ELIGIBILITY_POLICY.toolName,
  gates: FREECONTEXT_ELIGIBILITY_POLICY.gates,
  invariants: FREECONTEXT_ELIGIBILITY_POLICY.invariants,
});

function renderEligibilityPolicy(): string {
  const gates = FREECONTEXT_ELIGIBILITY_POLICY.gates
    .map((gate) => `Gate ${gate.order}: ${gate.instruction}`)
    .join(" ");
  return `For a call-eligible task, make gather_context your first read-only exploration action. ${gates} ${FREECONTEXT_ELIGIBILITY_POLICY.invariants.join(" ")}`;
}

export const TOOL_DESCRIPTION = renderEligibilityPolicy();
export const SERVER_INSTRUCTIONS = `FreeContext exposes one read-only ${FREECONTEXT_ELIGIBILITY_POLICY.toolName} tool governed by ${FREECONTEXT_ELIGIBILITY_POLICY.id} in its tool description. FreeContext binds each invocation to the public MCP request id and either an operator-configured absolute workspace root or exactly one public MCP file root; the caller supplies only the complete task and evidence questions. Invoke once per task, await the same outer cell while pending, and never replay before the terminal result. Never send credentials or source dumps, or retry unless the prior result names a material gap.`;

export const MODEL_RESULT_MAX_BYTES = 8_192;
export const RESULT_LIMITS = Object.freeze({
  evidence: 6,
  spanLines: 80,
  totalLines: 320,
  summaryCodePoints: 300,
  detailCodePoints: 120,
});

const codePointLength = (value: string): number => [...value].length;
const identifier = z.string().trim().min(1).max(160).regex(/^[^\r\n]+$/u);
const relativePath = z.string().trim().min(1).regex(/^[^\r\n]+$/u);
const singleLine = (maximum: number, allowEmpty = false) => z.string()
  .refine((value) => allowEmpty || value.trim().length > 0, "must not be empty")
  .refine((value) => !/[\r\n]/u.test(value), "must be a single line")
  .refine((value) => codePointLength(value) <= maximum, `must contain at most ${maximum} Unicode code points`);

export const EvidenceRoleSchema = z.enum(["implementation", "caller", "test", "contract"]);

export const KnownReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("path"), path: relativePath }).strict(),
  z.object({ kind: z.literal("symbol"), symbol: identifier, path: relativePath.optional() }).strict(),
  z.object({ kind: z.literal("stack"), path: relativePath, line: z.number().int().positive() }).strict(),
]);

export const EvidenceQuestionSchema = z.object({
  id: identifier,
  role: EvidenceRoleSchema,
  question: z.string().trim().min(1).refine((value) => codePointLength(value) <= 2_000, "question is too long"),
  required: z.boolean(),
}).strict();

const requestFields = {
  taskText: z.string()
    .refine((value) => value.trim().length > 0, "taskText must not be empty")
    .refine((value) => codePointLength(value) <= 16_000, "taskText is too long"),
  evidenceQuestions: z.array(EvidenceQuestionSchema).min(2).max(5),
};
const uniqueQuestions = ({ evidenceQuestions }: { evidenceQuestions: readonly { id: string }[] }, context: z.core.$RefinementCtx): void => {
  const seen = new Set<string>();
  for (const [index, question] of evidenceQuestions.entries()) {
    if (seen.has(question.id)) {
      context.addIssue({ code: "custom", path: ["evidenceQuestions", index, "id"], message: "question id must be unique" });
    }
    seen.add(question.id);
  }
};

const RawFreeContextRequestSchema = z.object({
  ...requestFields,
  knownRefs: z.array(KnownReferenceSchema).max(256).default([]),
}).strict().superRefine(uniqueQuestions);

export const FreeContextRequestSchema = z.object({
  ...requestFields,
  knownRefs: z.array(KnownReferenceSchema).max(12).default([]),
}).strict().superRefine(uniqueQuestions);

export const FreeContextInvocationContextSchema = z.object({
  invocationId: identifier,
  callId: identifier,
  workspaceRoot: z.string().trim().min(1),
  workspaceRevision: identifier,
  sessionId: identifier,
  sessionFile: z.string().trim().min(1),
}).strict();

export const FreeContextCallContextSchema = FreeContextInvocationContextSchema.pick({
  invocationId: true,
  callId: true,
  workspaceRoot: true,
  workspaceRevision: true,
});

export const FreeContextEvidenceSchema = z.object({
  role: EvidenceRoleSchema,
  path: relativePath,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  focusLine: z.number().int().positive(),
  questionId: identifier,
  why: singleLine(RESULT_LIMITS.detailCodePoints),
}).strict().superRefine(({ startLine, endLine, focusLine }, context) => {
  if (endLine < startLine) context.addIssue({ code: "custom", path: ["endLine"], message: "endLine must not precede startLine" });
  if (focusLine < startLine || focusLine > endLine) context.addIssue({ code: "custom", path: ["focusLine"], message: "focusLine must be inside the span" });
  if (endLine - startLine + 1 > RESULT_LIMITS.spanLines) context.addIssue({ code: "custom", path: ["endLine"], message: "evidence span is too large" });
});

export const FreeContextGapSchema = z.object({
  questionId: identifier,
  reason: singleLine(RESULT_LIMITS.detailCodePoints),
}).strict();

export const FreeContextNextActionSchema = z.object({
  kind: z.enum(["read", "direct_search"]),
  path: relativePath.optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  reason: singleLine(RESULT_LIMITS.detailCodePoints),
}).strict();

export const FreeContextErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "DEADLINE_EXCEEDED",
  "PROVIDER_RETRY_EXHAUSTED",
  "PROVIDER_FATAL",
  "SESSION_PERSISTENCE_FAILED",
  "RESULT_TOO_LARGE",
  "INTERNAL_ERROR",
]);

export const FreeContextResultSchema = z.object({
  status: z.enum(["ready", "partial", "not_found", "failed"]),
  summary: singleLine(RESULT_LIMITS.summaryCodePoints, true),
  evidence: z.array(FreeContextEvidenceSchema).max(RESULT_LIMITS.evidence),
  gaps: z.array(FreeContextGapSchema).max(5),
  nextAction: FreeContextNextActionSchema,
  errorCode: FreeContextErrorCodeSchema.nullable(),
  sessionId: identifier,
  sessionFile: z.string().trim().min(1).nullable(),
}).strict().superRefine((result, context) => {
  const hasEvidence = result.evidence.length > 0;
  const totalLines = result.evidence.reduce((sum, item) => sum + item.endLine - item.startLine + 1, 0);
  if (totalLines > RESULT_LIMITS.totalLines) context.addIssue({ code: "custom", path: ["evidence"], message: "total evidence coverage is too large" });
  if (result.status === "ready" || result.status === "partial") {
    if (!hasEvidence) context.addIssue({ code: "custom", path: ["evidence"], message: `${result.status} requires evidence` });
    if (result.nextAction.kind !== "read") context.addIssue({ code: "custom", path: ["nextAction", "kind"], message: `${result.status} requires a read action` });
    if (!result.sessionFile) context.addIssue({ code: "custom", path: ["sessionFile"], message: `${result.status} requires a committed session` });
  } else {
    if (hasEvidence) context.addIssue({ code: "custom", path: ["evidence"], message: `${result.status} cannot contain evidence` });
    if (result.nextAction.kind !== "direct_search") context.addIssue({ code: "custom", path: ["nextAction", "kind"], message: `${result.status} requires direct_search` });
  }
  if (result.status === "ready" && result.errorCode !== null) context.addIssue({ code: "custom", path: ["errorCode"], message: "ready cannot contain an error" });
  if (result.status === "not_found" && result.errorCode !== null) context.addIssue({ code: "custom", path: ["errorCode"], message: "not_found cannot contain an error" });
  if (result.status === "failed" && result.errorCode === null) context.addIssue({ code: "custom", path: ["errorCode"], message: "failed requires an error" });
  if (result.nextAction.kind === "read") {
    if (!result.nextAction.path || result.nextAction.startLine === undefined || result.nextAction.endLine === undefined) {
      context.addIssue({ code: "custom", path: ["nextAction"], message: "read requires path, startLine, and endLine" });
    } else if (result.nextAction.endLine < result.nextAction.startLine) {
      context.addIssue({ code: "custom", path: ["nextAction", "endLine"], message: "read range is invalid" });
    }
  }
});

export type EvidenceRole = z.infer<typeof EvidenceRoleSchema>;
export type KnownReference = z.infer<typeof KnownReferenceSchema>;
export type EvidenceQuestion = z.infer<typeof EvidenceQuestionSchema>;
export type FreeContextRequest = z.infer<typeof FreeContextRequestSchema>;
export type FreeContextInvocationContext = z.infer<typeof FreeContextInvocationContextSchema>;
export type FreeContextCallContext = z.infer<typeof FreeContextCallContextSchema>;
export type FreeContextEvidence = z.infer<typeof FreeContextEvidenceSchema>;
export type FreeContextGap = z.infer<typeof FreeContextGapSchema>;
export type FreeContextErrorCode = z.infer<typeof FreeContextErrorCodeSchema>;
export type FreeContextResult = z.infer<typeof FreeContextResultSchema>;

function normalizeKnownPath(value: string): string | null {
  const slashes = value.trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (!slashes || path.posix.isAbsolute(slashes)) return null;
  const normalized = path.posix.normalize(slashes);
  return normalized === "." || normalized === ".." || normalized.startsWith("../") ? null : normalized;
}

export function normalizeFreeContextRequest(rawRequest: unknown): Readonly<FreeContextRequest> {
  const raw = RawFreeContextRequestSchema.parse(rawRequest);
  const ranked = raw.knownRefs.map((reference, index) => {
    const normalizedPath = "path" in reference && reference.path
      ? normalizeKnownPath(reference.path)
      : undefined;
    if ("path" in reference && reference.path && !normalizedPath) return null;
    const normalized = reference.kind === "stack"
      ? { ...reference, path: normalizedPath as string }
      : reference.kind === "path"
        ? { ...reference, path: normalizedPath as string }
        : { ...reference, ...(normalizedPath ? { path: normalizedPath } : {}) };
    const priority = reference.kind === "stack"
      ? 0
      : reference.kind === "symbol" && normalizedPath
        ? 1
        : reference.kind === "path"
          ? 2
          : 3;
    return { normalized, index, priority, key: JSON.stringify(normalized) };
  }).filter((item) => item !== null);
  ranked.sort((left, right) => left.priority - right.priority || left.index - right.index);
  const seen = new Set<string>();
  const knownRefs: KnownReference[] = [];
  for (const item of ranked) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    knownRefs.push(item.normalized);
    if (knownRefs.length === 12) break;
  }
  return Object.freeze(FreeContextRequestSchema.parse({
    taskText: raw.taskText,
    knownRefs,
    evidenceQuestions: raw.evidenceQuestions,
  }));
}

export function serializeForModel(rawResult: Readonly<FreeContextResult>): string {
  const result = FreeContextResultSchema.parse(rawResult);
  const lines = [`Status: ${result.status}`, `Summary: ${result.summary}`, "Evidence:"];
  if (result.evidence.length === 0) lines.push("-");
  for (const [index, item] of result.evidence.entries()) {
    lines.push(`${index + 1}. [${item.role}][${item.questionId}] ${item.path}:${item.startLine}-${item.endLine} (focus ${item.focusLine}) — ${item.why}`);
  }
  const location = result.nextAction.kind === "read"
    ? `${result.nextAction.path}:${result.nextAction.startLine}-${result.nextAction.endLine}`
    : "-";
  lines.push(`First repository batch: ${result.nextAction.kind} ${location} — ${result.nextAction.reason}`);
  lines.push("Gaps:");
  if (result.gaps.length === 0) lines.push("-");
  for (const gap of result.gaps) lines.push(`- [${gap.questionId}] ${gap.reason}`);
  lines.push(`Error: ${result.errorCode ?? "-"}`);
  lines.push(`Session: ${result.sessionFile ?? result.sessionId}`);
  const text = lines.join("\n");
  if (Buffer.byteLength(text, "utf8") > MODEL_RESULT_MAX_BYTES) {
    throw new RangeError(`Serialized FreeContext result exceeds ${MODEL_RESULT_MAX_BYTES} bytes.`);
  }
  return text;
}
