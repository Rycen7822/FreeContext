import { z } from "zod";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export type FreeContextEligibilityOutcome = "call" | "direct_read" | "exact_probe";

export interface FreeContextEligibilityGate {
  readonly order: 1 | 2 | 3;
  readonly id: "bounded_direct_action" | "concrete_exploration_gap" | "exact_candidate_probe";
  readonly outcome: FreeContextEligibilityOutcome;
  readonly instruction: string;
}

export const FREECONTEXT_ELIGIBILITY_POLICY = Object.freeze({
  id: "freecontext-eligibility-v7",
  toolName: "gather_context",
  gates: Object.freeze([
    Object.freeze({
      order: 1,
      id: "bounded_direct_action",
      outcome: "direct_read",
      instruction: "Use native repository tools when the entire next source-understanding need closes with one or two small bounded reads, or for an exact path, symbol, precise failure location, diff or status, edit, test, or direct check.",
    }),
    Object.freeze({
      order: 2,
      id: "concrete_exploration_gap",
      outcome: "call",
      instruction: "Call before search or reading when one concrete next source-understanding question is expected to cross multiple non-adjacent owners or relationships; give each required area its own role-plus-question item.",
    }),
    Object.freeze({
      order: 3,
      id: "exact_candidate_probe",
      outcome: "exact_probe",
      instruction: "Use native exact path, symbol, or failure probes when the whole next question is local; do not call merely because work starts, a phase changes, the task is complex, or a probability threshold is reached.",
    }),
  ] satisfies readonly FreeContextEligibilityGate[]),
  invariants: Object.freeze([
    "Judge the whole next source-understanding phase, not each command: a concrete question expected to cross multiple non-adjacent owners or relationships calls FreeContext before exploration; one or two small reads stay native.",
    "Known references are priority starting hints, not a precondition. Exact paths, symbols, failure locations, one or two bounded reads, diff or status, edits, tests, and direct checks stay native.",
    "After an edit or check, a planned cross-module consistency audit may use typed reentry even before a failure; exact local failures stay native, and no second call is forced. Evidence-origin reentry is only for an independent child needed before acting.",
    "FreeContext is read-only: no edits, tests, Git, packages, web, or credentials.",
    "Read the selected skill before constructing a call; later eligible episodes call gather_context directly without catalog discovery.",
    "Question role is an evidence category, not an agent persona: use only implementation, caller, test, or contract.",
    "Each request names one stable outer edit, check, answer, or decision work unit. The initial invocation remains one call; send one evidenceQuestions item per required source area, each with only role and question, up to six, and let the server derive IDs, fact kind, required default, and coverage mode.",
    "Caller role defaults to relationship plus exhaustive coverage; implementation, test, and contract roles keep their role-appropriate fact kind and single coverage default. Do not expose a caller single override.",
    "An invocation is not a repository map: normally ask for the one atomic source-bound fact that directly unblocks the current work unit. For requested new behavior, ask for the nearest existing extension seam and confirmed presence or absence rather than presupposing a new symbol exists.",
    "Every required question is independently satisfied by role-matched evidence or its explicit gap; missing any required question remains partial. Exhaustive coverage needs every discovered member, an observed enumeration boundary, and gaps for anything unresolved.",
    "Use supported partial Evidence immediately. Execute the handoff; only a new typed child evidence question exposed while consuming Evidence or by edit/check may start another invocation.",
    "A continuation sends only priorSessionId, one new child question, and a typed edit, check, or evidence origin; optional knownRefs and parentGapId are allowed only when needed. The server restores the committed handoff, work unit, and request context, treating an omitted parentGapId as a handoff child and a supplied one as gap concretization.",
    "Continuation origin is structured as evidence with evidenceIds, edit with changedPaths, or check with check and optional failureLocation; do not guess hidden fields.",
    "Each gather_context invocation is atomic and non-replayable; a later invocation addresses a newly exposed evidence need without a fixed call-count rule.",
    "Inline Evidence excerpts are verified successful repository reads and may be used directly; one exact cited or adjacent read is allowed only when an excerpt omits change-critical context.",
    "After not_found, make the one exact probe and send only recovery with the returned priorSessionId and a workspace-relative probePath; committed prior request facts are restored by the server and cannot be overridden by the caller.",
    "Required coverage-slot total is at most six per payload envelope, not a semantic exploration limit.",
  ]),
});

export const FREECONTEXT_HOST_ROUTE_METADATA = Object.freeze({
  policyId: FREECONTEXT_ELIGIBILITY_POLICY.id,
  toolName: FREECONTEXT_ELIGIBILITY_POLICY.toolName,
  gates: FREECONTEXT_ELIGIBILITY_POLICY.gates,
  invariants: FREECONTEXT_ELIGIBILITY_POLICY.invariants,
});

function renderEligibilityPolicy(): string {
  return [
    `FreeContext eligibility policy ${FREECONTEXT_ELIGIBILITY_POLICY.id}.`,
    "Judge the whole next source-understanding question or phase, not each command.",
    "Gate 1: Use native tools when one or two small bounded reads close the whole question, or for an exact path, symbol, local failure, diff/status, edit, test, or direct check.",
    "Gate 2: Call before search or reading when one concrete question crosses multiple non-adjacent owners or relationships; send one role+question item per required area, up to six.",
    "Gate 3: Keep a local whole-question probe native; task start, phase change, apparent complexity, or probability is not a trigger.",
    "Caller is relationship+exhaustive; other roles use their role-appropriate fact kind and single coverage. After edit/check, a planned cross-module consistency audit may use typed reentry even without failure; reentry is optional.",
    "The call is atomic and read-only; consume partial Evidence and nextAction. Known references are optional hints. Never send credentials or source dumps.",
  ].join(" ");
}

export const TOOL_DESCRIPTION = renderEligibilityPolicy();
export const SERVER_INSTRUCTIONS = `FreeContext exposes one read-only ${FREECONTEXT_ELIGIBILITY_POLICY.toolName} tool governed by ${FREECONTEXT_ELIGIBILITY_POLICY.id}. It binds each call to the public request and operator workspace. Initial callers send one work unit and one role-plus-question item per required area; the server derives the remaining fields and coverage defaults. Continuations send only priorSessionId, one child question, one typed origin, and optional knownRefs or parentGapId; the server restores and validates the committed context. Recovery sends only priorSessionId and one workspace-relative probePath. The invocation is atomic with one terminal result. Follow nextAction and consume partial Evidence. Ready is invocation-scoped. Never send credentials or source dumps.`;

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

export const EvidenceRoleSchema = z.enum(["implementation", "caller", "test", "contract"])
  .describe("Evidence category, not an agent persona; use only implementation, caller, test, or contract.");

export const WorkUnitSchema = z.object({
  outcome: z.enum(["edit", "check", "answer", "decision"]),
  goal: singleLine(500),
}).strict();

export const EvidenceTargetSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("path"), path: relativePath }).strict(),
  z.object({ kind: z.literal("symbol"), symbol: identifier, path: relativePath.optional() }).strict(),
  z.object({ kind: z.literal("topic"), topic: singleLine(RESULT_LIMITS.detailCodePoints) }).strict(),
]);

export const BlockingGapKindSchema = z.enum([
  "cross_file_unknown",
  "cross_document_unknown",
  "contract_unknown",
  "verification_unknown",
  "multi_keyword_unknown",
]);

export const ReentryGapOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("evidence_consumption"), evidenceIds: z.array(identifier).min(1).max(RESULT_LIMITS.evidence) }).strict(),
  z.object({ kind: z.literal("edit"), changedPaths: z.array(relativePath).min(1).max(12) }).strict(),
  z.object({ kind: z.literal("check"), check: singleLine(RESULT_LIMITS.detailCodePoints), failureLocation: singleLine(RESULT_LIMITS.detailCodePoints).optional() }).strict(),
]).describe("The new blocking gap must be caused by consuming returned Evidence, an edit, or a check; use the matching structured fields.");

export const ReentryDerivationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("handoff_child"), parentHandoffId: identifier }).strict(),
  z.object({ kind: z.literal("gap_concretization"), parentGapId: identifier }).strict(),
]).describe("Auditable child relationship: derive from the prior handoff or concretize one named prior gap.");

export const ReentryBlockingGapSchema = z.object({
  id: identifier,
  questionId: identifier,
  targetId: identifier,
  kind: BlockingGapKindSchema,
  scope: EvidenceTargetSubjectSchema,
  requiredFact: singleLine(500),
  derivation: ReentryDerivationSchema,
  origin: ReentryGapOriginSchema,
}).strict().describe("A typed child blocker linked to one current target, one prior parent, and one structured origin.");

export const PriorHandoffSchema = z.object({
  id: identifier,
  workUnit: WorkUnitSchema,
  evidenceIds: z.array(identifier).max(RESULT_LIMITS.evidence),
  outcome: z.object({
    kind: z.enum(["edit", "check", "answer", "decision"]),
    instruction: singleLine(500),
  }).strict(),
  addressedFacts: z.array(z.object({
    questionId: identifier,
    targetId: identifier,
    scope: EvidenceTargetSubjectSchema,
    requiredFact: singleLine(500),
  }).strict()).max(RESULT_LIMITS.evidence).optional(),
  blockingGaps: z.array(z.object({
    id: identifier,
    targetId: identifier,
    kind: z.enum(["source_unknown", ...BlockingGapKindSchema.options]),
    scope: EvidenceTargetSubjectSchema,
    requiredFact: singleLine(500),
  }).strict()).max(RESULT_LIMITS.evidence),
}).strict().describe("The complete prior handoff returned by the preceding invocation; pass it verbatim on reentry.");

export const FreeContextReentrySchema = z.object({
  // This field is internal provenance used to enforce one-time public continuation consumption.
  priorSessionId: identifier.optional(),
  priorHandoff: PriorHandoffSchema,
  blockingGap: ReentryBlockingGapSchema,
}).strict().describe("A later invocation preserves the prior handoff and exact work unit while addressing one new typed blocking gap.");

export const FreeContextRecoveryRequestSchema = z.object({
  priorSessionId: identifier,
  probePath: relativePath.refine((value) => normalizeKnownPath(value) !== null, "probePath must be workspace-relative"),
}).strict().describe("The complete recovery-only caller payload: copy priorSessionId from not_found and add the observed workspace-relative probePath.");

export const CoverageTargetSchema = z.object({
  id: identifier,
  subject: EvidenceTargetSubjectSchema,
  factKind: z.enum(["location", "definition", "behavior", "relationship", "contract", "verification", "presence"]),
  coverageMode: z.enum(["single", "exhaustive"]),
}).strict();

export const FreeContextCallerCoverageTargetSchema = z.object({
  subject: EvidenceTargetSubjectSchema,
}).strict().describe("Optional precise subject override only; the server derives the target ID and role-based factKind and coverageMode (caller is relationship plus exhaustive, other roles are single).");

export const KnownReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("path"), path: relativePath }).strict(),
  z.object({ kind: z.literal("symbol"), symbol: identifier, path: relativePath.optional() }).strict(),
  z.object({ kind: z.literal("stack"), path: relativePath, line: z.number().int().positive() }).strict(),
]);

const CanonicalEvidenceQuestionSchema = z.object({
  id: identifier,
  role: EvidenceRoleSchema,
  question: z.string().trim().min(1).refine((value) => codePointLength(value) <= 2_000, "question is too long"),
  required: z.boolean(),
  coverageTargets: z.array(CoverageTargetSchema).length(1)
    .describe("The single structured fact target bound to this question."),
  minimumSpans: z.number().int().min(1).max(RESULT_LIMITS.evidence).optional()
    .describe("Minimum distinct evidence spans required for this question; omit for one."),
}).strict();

const canonicalRequestFields = {
  taskText: z.string()
    .refine((value) => value.trim().length > 0, "taskText must not be empty")
    .refine((value) => codePointLength(value) <= 16_000, "taskText is too long"),
  workUnit: WorkUnitSchema,
  evidenceQuestions: z.array(CanonicalEvidenceQuestionSchema).min(1).max(RESULT_LIMITS.evidence),
  reentry: FreeContextReentrySchema.optional(),
  recovery: FreeContextRecoveryRequestSchema.optional(),
};
const validateQuestions = ({ evidenceQuestions }: {
  evidenceQuestions: readonly {
    id: string;
    required: boolean;
    coverageTargets: readonly { id: string }[];
    minimumSpans?: number | undefined;
  }[];
}, context: z.core.$RefinementCtx): void => {
  const questionIds = new Set<string>();
  const targetIds = new Set<string>();
  let requiredSpans = 0;
  let targetSlots = 0;
  for (const [index, question] of evidenceQuestions.entries()) {
    if (questionIds.has(question.id)) {
      context.addIssue({ code: "custom", path: ["evidenceQuestions", index, "id"], message: "question id must be unique" });
    }
    questionIds.add(question.id);
    for (const [targetIndex, target] of question.coverageTargets.entries()) {
      if (targetIds.has(target.id)) {
        context.addIssue({ code: "custom", path: ["evidenceQuestions", index, "coverageTargets", targetIndex, "id"], message: "target id must be unique within the request" });
      }
      targetIds.add(target.id);
    }
    targetSlots += question.coverageTargets.length;
    if (question.required) requiredSpans += Math.max(question.minimumSpans ?? 1, question.coverageTargets.length);
    if (!question.required && question.minimumSpans !== undefined && question.minimumSpans !== 1) {
      context.addIssue({ code: "custom", path: ["evidenceQuestions", index, "minimumSpans"], message: "optional questions cannot require multiple spans" });
    }
  }
  if (requiredSpans > RESULT_LIMITS.evidence) {
    context.addIssue({ code: "custom", path: ["evidenceQuestions"], message: `required coverage slots cannot exceed ${RESULT_LIMITS.evidence}` });
  }
  if (targetSlots > RESULT_LIMITS.evidence) {
    context.addIssue({ code: "custom", path: ["evidenceQuestions"], message: `coverage targets cannot exceed ${RESULT_LIMITS.evidence}` });
  }
};

// Canonical request used after the MCP caller boundary has assigned question and target IDs.
function validateContinuationShape(
  request: { workUnit: z.infer<typeof WorkUnitSchema>; reentry?: z.infer<typeof FreeContextReentrySchema> | undefined; recovery?: z.infer<typeof FreeContextRecoveryRequestSchema> | undefined },
  context: z.core.$RefinementCtx,
): void {
  if (request.reentry && request.recovery) {
    context.addIssue({ code: "custom", path: ["reentry"], message: "A request cannot combine typed reentry and not_found recovery." });
  }
}

export const FreeContextRequestSchema = z.object({
  ...canonicalRequestFields,
  knownRefs: z.array(KnownReferenceSchema).max(12).default([]),
}).strict().superRefine((request, context) => {
  validateQuestions(request, context);
  validateContinuationShape(request, context);
});

const HistoricalReentryGapOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("evidence_consumption"), evidenceIds: z.array(identifier).min(1).max(RESULT_LIMITS.evidence), priorGapId: identifier.optional() }).strict(),
  z.object({ kind: z.literal("edit"), changedPaths: z.array(relativePath).min(1).max(12) }).strict(),
  z.object({ kind: z.literal("check"), check: singleLine(RESULT_LIMITS.detailCodePoints), failureLocation: singleLine(RESULT_LIMITS.detailCodePoints).optional() }).strict(),
]);
const HistoricalPriorHandoffSchema = PriorHandoffSchema.omit({ addressedFacts: true });
const HistoricalReentrySchema = z.object({
  priorHandoff: HistoricalPriorHandoffSchema,
  blockingGap: ReentryBlockingGapSchema.omit({ questionId: true, derivation: true }).extend({ origin: HistoricalReentryGapOriginSchema }),
}).strict();
const HistoricalRecoverySchema = z.object({
  requestKind: z.literal("not_found_recovery"),
  priorSessionId: identifier,
  priorWorkUnit: WorkUnitSchema,
  probe: z.object({ kind: z.literal("exact_probe"), path: relativePath }).strict(),
}).strict();
export const HistoricalFreeContextRequestSchema = z.object({
  taskText: canonicalRequestFields.taskText,
  workUnit: WorkUnitSchema,
  knownRefs: z.array(KnownReferenceSchema).max(12),
  evidenceQuestions: z.array(CanonicalEvidenceQuestionSchema).min(1).max(RESULT_LIMITS.evidence),
  reentry: HistoricalReentrySchema.optional(),
  recovery: HistoricalRecoverySchema.optional(),
}).strict().superRefine((request, context) => {
  validateQuestions(request, context);
  if (request.reentry && request.recovery) {
    context.addIssue({ code: "custom", path: ["reentry"], message: "Historical request cannot combine reentry and recovery." });
  }
});

export const FreeContextCallerEvidenceQuestionSchema = z.object({
  role: EvidenceRoleSchema,
  question: z.string().trim().min(1).refine((value) => codePointLength(value) <= 2_000, "question is too long")
    .describe("Name one existing-code owner or decision. Use one item per required source area rather than combining areas. For new behavior, ask for its nearest extension seam or confirmed absence instead of presupposing the requested symbol exists."),
  required: z.boolean().default(true),
  target: FreeContextCallerCoverageTargetSchema.optional()
    .describe("Optional precise subject override; otherwise the question becomes a normalized topic target."),
}).strict();

export const FreeContextCallerReentryOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("evidence"), evidenceIds: z.array(identifier).min(1).max(RESULT_LIMITS.evidence) }).strict(),
  z.object({ kind: z.literal("edit"), changedPaths: z.array(relativePath).min(1).max(12) }).strict(),
  z.object({ kind: z.literal("check"), check: singleLine(RESULT_LIMITS.detailCodePoints), failureLocation: singleLine(RESULT_LIMITS.detailCodePoints).optional() }).strict(),
]).describe("The compact continuation cause: evidence consumption, an edit, or a check.");

export const FreeContextCallerReentrySchema = z.object({
  priorSessionId: identifier,
  question: FreeContextCallerEvidenceQuestionSchema,
  origin: FreeContextCallerReentryOriginSchema,
  knownRefs: z.array(KnownReferenceSchema).max(12).optional(),
  parentGapId: identifier.optional(),
}).strict().describe("Compact continuation: the server restores the prior committed request and handoff from priorSessionId.");

export const FreeContextCallerFullRequestSchema = z.object({
  taskText: canonicalRequestFields.taskText,
  workUnit: WorkUnitSchema,
  knownRefs: z.array(KnownReferenceSchema).max(12).default([]),
  evidenceQuestions: z.array(FreeContextCallerEvidenceQuestionSchema).min(1).max(RESULT_LIMITS.evidence),
}).strict();

export const FreeContextCallerRecoveryRequestSchema = z.object({
  recovery: FreeContextRecoveryRequestSchema,
}).strict().describe("Recovery-only call; prior request facts are restored from the committed not_found session.");

export const FreeContextCallerReentryRequestSchema = z.object({
  reentry: FreeContextCallerReentrySchema,
}).strict();

export const FreeContextCallerRequestSchema = z.object({
  taskText: canonicalRequestFields.taskText.optional(),
  workUnit: WorkUnitSchema.optional(),
  knownRefs: z.array(KnownReferenceSchema).max(12).optional(),
  evidenceQuestions: z.array(FreeContextCallerEvidenceQuestionSchema).min(1).max(RESULT_LIMITS.evidence).optional(),
  reentry: FreeContextCallerReentrySchema.optional(),
  recovery: FreeContextRecoveryRequestSchema.optional(),
}).strict().superRefine((request, context) => {
  if (request.recovery) {
    for (const key of ["taskText", "workUnit", "knownRefs", "evidenceQuestions", "reentry"] as const) {
      if (request[key] !== undefined) context.addIssue({ code: "custom", path: [key], message: "Recovery must be the only caller field." });
    }
    return;
  }
  if (request.reentry) {
    for (const key of ["taskText", "workUnit", "knownRefs", "evidenceQuestions"] as const) {
      if (request[key] !== undefined) context.addIssue({ code: "custom", path: [key], message: "Continuation must be the only caller field." });
    }
    return;
  }
  const fullRequest = FreeContextCallerFullRequestSchema.safeParse(request);
  if (!fullRequest.success) {
    for (const issue of fullRequest.error.issues) {
      context.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  }
}).describe("One full initial request with one role-plus-question item per required source area, one compact continuation, or one recovery-only request with no caller-supplied prior facts.");

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
  id: identifier.optional(),
  role: EvidenceRoleSchema,
  path: relativePath,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  focusLine: z.number().int().positive(),
  questionId: identifier,
  targetId: identifier.optional(),
  excerpt: z.string().min(1).optional(),
  why: singleLine(RESULT_LIMITS.detailCodePoints),
}).strict().superRefine(({ startLine, endLine, focusLine }, context) => {
  if (endLine < startLine) context.addIssue({ code: "custom", path: ["endLine"], message: "endLine must not precede startLine" });
  if (focusLine < startLine || focusLine > endLine) context.addIssue({ code: "custom", path: ["focusLine"], message: "focusLine must be inside the span" });
  if (endLine - startLine + 1 > RESULT_LIMITS.spanLines) context.addIssue({ code: "custom", path: ["endLine"], message: "evidence span is too large" });
});

export const FreeContextGapSchema = z.object({
  questionId: identifier,
  targetId: identifier.optional(),
  reason: singleLine(RESULT_LIMITS.detailCodePoints),
}).strict();

export const FreeContextCoverageSchema = z.object({
  targetId: identifier,
  mode: z.literal("exhaustive"),
  members: z.array(singleLine(RESULT_LIMITS.detailCodePoints)).max(64),
  basisEvidenceIds: z.array(identifier).max(RESULT_LIMITS.evidence),
  gaps: z.array(singleLine(RESULT_LIMITS.detailCodePoints)).max(RESULT_LIMITS.evidence),
  omittedMembers: z.number().int().nonnegative().default(0),
}).strict();

export const FreeContextNextActionSchema = z.object({
  kind: z.enum(["consume_evidence", "exact_probe"]),
  reason: singleLine(RESULT_LIMITS.detailCodePoints),
  recovery: z.object({
    priorSessionId: identifier,
  }).strict().optional().describe("Present only for not_found: copy priorSessionId and add probePath after one exact probe."),
}).strict().describe("consume_evidence means consume the returned Evidence and execute the handoff; exact_probe means one bounded probe before broader discovery.");

export const FreeContextHandoffGapSchema = PriorHandoffSchema.shape.blockingGaps.element;

export const FreeContextHandoffSchema = PriorHandoffSchema;

export const FreeContextErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "DEADLINE_EXCEEDED",
  "PROVIDER_RETRY_EXHAUSTED",
  "PROVIDER_FATAL",
  "SESSION_PERSISTENCE_FAILED",
  "RESULT_TOO_LARGE",
  "INTERNAL_ERROR",
]);

const FreeContextResultBaseSchema = z.object({
  status: z.enum(["ready", "partial", "not_found", "failed"]),
  summary: singleLine(RESULT_LIMITS.summaryCodePoints, true),
  evidence: z.array(FreeContextEvidenceSchema).max(RESULT_LIMITS.evidence),
  gaps: z.array(FreeContextGapSchema).max(RESULT_LIMITS.evidence),
  coverage: z.array(FreeContextCoverageSchema).max(RESULT_LIMITS.evidence).optional(),
  handoff: FreeContextHandoffSchema.nullable().optional(),
  nextAction: FreeContextNextActionSchema,
  errorCode: FreeContextErrorCodeSchema.nullable(),
  sessionId: identifier,
  sessionFile: z.string().trim().min(1).nullable(),
}).strict();

function validateFreeContextResult(
  result: z.infer<typeof FreeContextResultBaseSchema>,
  context: z.core.$RefinementCtx,
  requireRecovery: boolean,
): void {
  const hasEvidence = result.evidence.length > 0;
  const totalLines = result.evidence.reduce((sum, item) => sum + item.endLine - item.startLine + 1, 0);
  const returnedEvidenceIds = result.evidence.flatMap((item) => item.id ? [item.id] : []);
  const evidenceIds = new Set(returnedEvidenceIds);
  const coverageTargets = new Set<string>();
  if (totalLines > RESULT_LIMITS.totalLines) context.addIssue({ code: "custom", path: ["evidence"], message: "total evidence coverage is too large" });
  if (evidenceIds.size !== returnedEvidenceIds.length) context.addIssue({ code: "custom", path: ["evidence"], message: "evidence id must be unique" });
  if (result.status === "ready" || result.status === "partial") {
    if (!hasEvidence) context.addIssue({ code: "custom", path: ["evidence"], message: `${result.status} requires evidence` });
    if (result.nextAction.kind !== "consume_evidence") context.addIssue({ code: "custom", path: ["nextAction", "kind"], message: `${result.status} requires consume_evidence` });
    if (!result.sessionFile) context.addIssue({ code: "custom", path: ["sessionFile"], message: `${result.status} requires a committed session` });
    if (!result.handoff) context.addIssue({ code: "custom", path: ["handoff"], message: `${result.status} requires a cohesive handoff` });
  } else {
    if (hasEvidence) context.addIssue({ code: "custom", path: ["evidence"], message: `${result.status} cannot contain evidence` });
    if (result.nextAction.kind !== "exact_probe") context.addIssue({ code: "custom", path: ["nextAction", "kind"], message: `${result.status} requires exact_probe` });
    if (result.handoff) context.addIssue({ code: "custom", path: ["handoff"], message: `${result.status} cannot contain a handoff` });
    if (result.status !== "not_found" && result.nextAction.recovery) {
      context.addIssue({ code: "custom", path: ["nextAction", "recovery"], message: "Only not_found may expose recovery." });
    }
    if (result.status === "not_found") {
      if (requireRecovery && !result.nextAction.recovery) {
        context.addIssue({ code: "custom", path: ["nextAction", "recovery"], message: "not_found requires structured recovery." });
      }
      if (result.nextAction.recovery && !isDeepStrictEqual(result.sessionId, result.nextAction.recovery.priorSessionId)) {
        context.addIssue({ code: "custom", path: ["nextAction", "recovery", "priorSessionId"], message: "not_found recovery must bind to the result session." });
      }
    }
  }
  if (result.status === "ready" && result.errorCode !== null) context.addIssue({ code: "custom", path: ["errorCode"], message: "ready cannot contain an error" });
  if (result.status === "not_found" && result.errorCode !== null) context.addIssue({ code: "custom", path: ["errorCode"], message: "not_found cannot contain an error" });
  if (result.status === "failed" && result.errorCode === null) context.addIssue({ code: "custom", path: ["errorCode"], message: "failed requires an error" });
  if (result.handoff) {
    if (result.handoff.workUnit.outcome !== result.handoff.outcome.kind) {
      context.addIssue({ code: "custom", path: ["handoff", "outcome", "kind"], message: "handoff outcome must match the work unit" });
    }
    if (result.handoff.evidenceIds.some((id) => !evidenceIds.has(id))) {
      context.addIssue({ code: "custom", path: ["handoff", "evidenceIds"], message: "handoff must reference returned Evidence" });
    }
    if (new Set(result.handoff.blockingGaps.map((gap) => gap.id)).size !== result.handoff.blockingGaps.length) {
      context.addIssue({ code: "custom", path: ["handoff", "blockingGaps"], message: "handoff blocking gap id must be unique" });
    }
    if (result.status === "ready" && result.handoff.blockingGaps.length > 0) {
      context.addIssue({ code: "custom", path: ["handoff", "blockingGaps"], message: "ready handoff cannot contain blocking gaps" });
    }
  }
  for (const [index, coverage] of (result.coverage ?? []).entries()) {
    if (coverageTargets.has(coverage.targetId)) context.addIssue({ code: "custom", path: ["coverage", index, "targetId"], message: "coverage target must be unique" });
    coverageTargets.add(coverage.targetId);
    if (coverage.basisEvidenceIds.some((id) => !evidenceIds.has(id))) {
      context.addIssue({ code: "custom", path: ["coverage", index, "basisEvidenceIds"], message: "coverage basis must reference returned Evidence" });
    }
    if (result.status === "ready" && (coverage.members.length === 0 || coverage.basisEvidenceIds.length === 0
      || coverage.gaps.length > 0 || coverage.omittedMembers > 0)) {
      context.addIssue({ code: "custom", path: ["coverage", index], message: "ready exhaustive coverage requires members, valid basis, and no gaps or omissions" });
    }
  }
}

export const LegacyFreeContextResultSchema = FreeContextResultBaseSchema.superRefine((result, context) => {
  validateFreeContextResult(result, context, false);
}).describe("Historical result reader: missing not_found recovery is retained as legacy and is not current-runtime valid.");

export const HistoricalNotFoundFreeContextResultSchema = FreeContextResultBaseSchema.omit({
  status: true,
  evidence: true,
  handoff: true,
  nextAction: true,
  errorCode: true,
}).extend({
  status: z.literal("not_found"),
  evidence: z.array(FreeContextEvidenceSchema).length(0),
  handoff: z.null().optional(),
  nextAction: z.object({
    kind: z.literal("exact_probe"),
    reason: singleLine(RESULT_LIMITS.detailCodePoints),
    recovery: z.object({
      requestKind: z.literal("not_found_recovery"),
      priorSessionId: identifier,
      workUnit: WorkUnitSchema,
      requiredProbe: z.literal("exact_probe"),
    }).strict(),
  }).strict(),
  errorCode: z.null(),
}).strict().superRefine((result, context) => {
  if (result.sessionId !== result.nextAction.recovery.priorSessionId) {
    context.addIssue({
      code: "custom",
      path: ["nextAction", "recovery", "priorSessionId"],
      message: "historical not_found recovery must bind to the result session",
    });
  }
}).describe("Historical reader for the retired not_found recovery payload; never accepted as a current runtime result.");

export const FreeContextResultSchema = FreeContextResultBaseSchema.superRefine((result, context) => {
  validateFreeContextResult(result, context, true);
}).describe("Current runtime result contract: not_found must carry structured recovery.");

export type EvidenceRole = z.infer<typeof EvidenceRoleSchema>;
export type WorkUnit = z.infer<typeof WorkUnitSchema>;
export type EvidenceTargetSubject = z.infer<typeof EvidenceTargetSubjectSchema>;
export type CoverageTarget = z.infer<typeof CoverageTargetSchema>;
export type KnownReference = z.infer<typeof KnownReferenceSchema>;
export type EvidenceQuestion = z.infer<typeof CanonicalEvidenceQuestionSchema>;
export type FreeContextCallerEvidenceQuestion = z.infer<typeof FreeContextCallerEvidenceQuestionSchema>;
export type FreeContextCallerReentryOrigin = z.infer<typeof FreeContextCallerReentryOriginSchema>;
export type FreeContextCallerReentry = z.infer<typeof FreeContextCallerReentrySchema>;
export type FreeContextCallerFullRequest = z.infer<typeof FreeContextCallerFullRequestSchema>;
export type FreeContextCallerReentryRequest = z.infer<typeof FreeContextCallerReentryRequestSchema>;
export type FreeContextCallerRecoveryRequest = z.infer<typeof FreeContextCallerRecoveryRequestSchema>;
export type FreeContextCallerRequest = FreeContextCallerFullRequest | FreeContextCallerReentryRequest | FreeContextCallerRecoveryRequest;
export type ReentryBlockingGap = z.infer<typeof ReentryBlockingGapSchema>;
export type ReentryGapOrigin = z.infer<typeof ReentryGapOriginSchema>;
export type ReentryDerivation = z.infer<typeof ReentryDerivationSchema>;
export type PriorHandoff = z.infer<typeof PriorHandoffSchema>;
export type FreeContextRecoveryRequest = z.infer<typeof FreeContextRecoveryRequestSchema>;
export type FreeContextRequest = z.infer<typeof FreeContextRequestSchema>;
export type FreeContextInvocationContext = z.infer<typeof FreeContextInvocationContextSchema>;
export type FreeContextCallContext = z.infer<typeof FreeContextCallContextSchema>;
export type FreeContextEvidence = z.infer<typeof FreeContextEvidenceSchema>;
export type FreeContextGap = z.infer<typeof FreeContextGapSchema>;
export type FreeContextCoverage = z.infer<typeof FreeContextCoverageSchema>;
export type FreeContextHandoff = z.infer<typeof FreeContextHandoffSchema>;
export type FreeContextErrorCode = z.infer<typeof FreeContextErrorCodeSchema>;
export type FreeContextResult = z.infer<typeof FreeContextResultSchema>;
export type LegacyFreeContextResult = z.infer<typeof LegacyFreeContextResultSchema>;

export function minimumEvidenceSpans(question: Readonly<EvidenceQuestion>): number {
  return question.minimumSpans ?? 1;
}

export function questionCoverageTargets(question: Readonly<EvidenceQuestion>): readonly CoverageTarget[] {
  return question.coverageTargets;
}

export function requiredEvidenceSlots(question: Readonly<EvidenceQuestion>): number {
  return Math.max(minimumEvidenceSpans(question), questionCoverageTargets(question).length);
}

export function handoffGapFor(
  question: Readonly<EvidenceQuestion>,
  target: Readonly<CoverageTarget>,
): z.infer<typeof FreeContextHandoffGapSchema> {
  const kind = target.factKind === "contract"
    ? "contract_unknown"
    : target.factKind === "verification"
      ? "verification_unknown"
      : target.subject.kind === "topic"
        ? "cross_document_unknown"
        : "source_unknown";
  return Object.freeze({
    id: `gap:${target.id}`,
    targetId: target.id,
    kind,
    scope: target.subject,
    requiredFact: question.question,
  });
}

function normalizeKnownPath(value: string): string | null {
  const slashes = value.trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (!slashes || path.posix.isAbsolute(slashes) || /^[A-Za-z]:\//u.test(slashes)) return null;
  const normalized = path.posix.normalize(slashes);
  return normalized === "." || normalized === ".." || normalized.startsWith("../") ? null : normalized;
}

export function normalizeKnownReferences(rawReferences: readonly KnownReference[]): readonly KnownReference[] {
  const ranked = rawReferences.map((reference, index) => {
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
  return Object.freeze(knownRefs);
}

function normalizedCallerQuestion(
  question: Readonly<FreeContextCallerEvidenceQuestion>,
  questionId: string,
): Readonly<EvidenceQuestion> {
  const defaultTopic = [...question.question.replace(/\s+/gu, " ").trim()]
    .slice(0, RESULT_LIMITS.detailCodePoints)
    .join("");
  const target = question.target ?? { subject: { kind: "topic" as const, topic: defaultTopic } };
  const inferredFactKind = question.role === "test"
    ? "verification" as const
    : question.role === "contract"
      ? "contract" as const
      : question.role === "caller"
        ? "relationship" as const
        : "behavior" as const;
  const coverageMode = question.role === "caller" ? "exhaustive" as const : "single" as const;
  return Object.freeze({
    id: questionId,
    role: question.role,
    question: question.question,
    required: question.required,
    coverageTargets: [{
      id: `target:${questionId}`,
      subject: target.subject,
      factKind: inferredFactKind,
      coverageMode,
    }],
  });
}

export function normalizeFreeContextRequest(rawRequest: unknown): Readonly<FreeContextRequest> {
  const canonical = FreeContextRequestSchema.safeParse(rawRequest);
  if (canonical.success) return Object.freeze(canonical.data);
  const legacyReentry = rawRequest && typeof rawRequest === "object" && "reentry" in rawRequest
    ? (rawRequest as { reentry?: unknown }).reentry
    : undefined;
  const callerInput = legacyReentry === undefined || !rawRequest || typeof rawRequest !== "object"
    ? rawRequest
    : Object.fromEntries(Object.entries(rawRequest).filter(([key]) => key !== "reentry"));
  const raw = FreeContextCallerFullRequestSchema.parse(callerInput);
  const evidenceQuestions = raw.evidenceQuestions.map((question, questionIndex) =>
    normalizedCallerQuestion(question, `q${questionIndex + 1}`));
  return Object.freeze(FreeContextRequestSchema.parse({
    taskText: raw.taskText,
    workUnit: raw.workUnit,
    knownRefs: normalizeKnownReferences(raw.knownRefs),
    evidenceQuestions,
    ...(legacyReentry !== undefined ? { reentry: legacyReentry } : {}),
  }));
}

export function normalizeFreeContextContinuationRequest(
  rawReentry: unknown,
  priorRequest: Readonly<FreeContextRequest>,
  priorHandoff: Readonly<FreeContextHandoff>,
): Readonly<FreeContextRequest> {
  const raw = FreeContextCallerReentrySchema.parse(rawReentry);
  const questionId = `q${priorRequest.evidenceQuestions.length + 1}`;
  const question = normalizedCallerQuestion(raw.question, questionId);
  const target = question.coverageTargets[0];
  if (!target) throw new Error("Continuation question must have one target.");
  const baseGapId = `gap:child:${target.id.slice(0, 140)}`;
  const occupiedGapIds = new Set([priorHandoff.id, ...priorHandoff.blockingGaps.map((gap) => gap.id)]);
  let gapId = baseGapId;
  let gapSuffix = 2;
  while (occupiedGapIds.has(gapId)) {
    gapId = `${baseGapId.slice(0, 157 - String(gapSuffix).length)}:${gapSuffix}`;
    gapSuffix += 1;
  }
  const origin = raw.origin.kind === "evidence"
    ? { kind: "evidence_consumption" as const, evidenceIds: raw.origin.evidenceIds }
    : raw.origin;
  const gapKind = target.factKind === "contract"
    ? "contract_unknown" as const
    : target.factKind === "verification"
      ? "verification_unknown" as const
      : target.subject.kind === "topic"
        ? "cross_document_unknown" as const
        : "cross_file_unknown" as const;
  const blockingGap = {
    id: gapId,
    questionId,
    targetId: target.id,
    kind: gapKind,
    scope: target.subject,
    requiredFact: question.question,
    derivation: raw.parentGapId
      ? { kind: "gap_concretization" as const, parentGapId: raw.parentGapId }
      : { kind: "handoff_child" as const, parentHandoffId: priorHandoff.id },
    origin,
  } satisfies ReentryBlockingGap;
  return Object.freeze(FreeContextRequestSchema.parse({
    taskText: priorRequest.taskText,
    workUnit: priorRequest.workUnit,
    knownRefs: normalizeKnownReferences(raw.knownRefs ?? priorRequest.knownRefs),
    evidenceQuestions: [question],
    reentry: {
      priorSessionId: raw.priorSessionId,
      priorHandoff,
      blockingGap,
    },
  }));
}

export function normalizeFreeContextRecoveryRequest(rawRecovery: unknown): Readonly<FreeContextRecoveryRequest> {
  const recovery = FreeContextRecoveryRequestSchema.parse(rawRecovery);
  return Object.freeze(FreeContextRecoveryRequestSchema.parse({
    ...recovery,
    probePath: normalizeKnownPath(recovery.probePath) ?? "",
  }));
}

export function serializeForModel(rawResult: Readonly<FreeContextResult>): string {
  const result = FreeContextResultSchema.parse(rawResult);
  const lines = [`Status: ${result.status}`, "Evidence:"];
  if (result.evidence.length === 0) lines.push("-");
  for (const [index, item] of result.evidence.entries()) {
    lines.push(`${index + 1}. ${item.id ? `[${item.id}]` : ""}[${item.role}][${item.questionId}]${item.targetId ? `[target:${item.targetId}]` : ""} ${item.path}:${item.startLine}-${item.endLine} (focus ${item.focusLine}) — ${item.why}`);
    if (item.excerpt !== undefined) lines.push(`Excerpt (observed):\n${item.excerpt}`);
  }
  lines.push("Exhaustive coverage:");
  if ((result.coverage?.length ?? 0) === 0) lines.push("-");
  for (const coverage of result.coverage ?? []) {
    lines.push(`- [target:${coverage.targetId}] members=${JSON.stringify(coverage.members)} basis=${JSON.stringify(coverage.basisEvidenceIds)} omitted=${coverage.omittedMembers}`);
    for (const gap of coverage.gaps) lines.push(`  gap: ${gap}`);
  }
  lines.push("Handoff:");
  if (!result.handoff) lines.push("-");
  else lines.push(`- prior_handoff=${JSON.stringify(result.handoff)}`);
  if (result.nextAction.kind === "consume_evidence") {
    lines.push(`Follow nextAction: consume inline Evidence and proceed to edit/check. If change-critical context is omitted, one necessary adjacent read on an Evidence path is allowed. A listed gap is not replay authorization; for a new gather-level child, send compact reentry with priorSessionId, one question, and a typed evidence/edit/check origin, plus parentGapId only for gap concretization. Same-fact replay remains invalid. ${result.nextAction.reason}`);
  } else {
    lines.push(`Follow nextAction: make one exact non-broad path or symbol probe and read at most one candidate path; broader discovery calls FreeContext. ${result.nextAction.reason}`);
    if (result.nextAction.recovery) {
      lines.push(`Recovery contract: after the exact probe, call gather_context with only {"recovery":{"priorSessionId":${JSON.stringify(result.nextAction.recovery.priorSessionId)},"probePath":"<workspace-relative probed path>"}}. Do not resend or rewrite taskText, workUnit, knownRefs, evidenceQuestions, or a handoff.`);
    }
  }
  lines.push("Gaps:");
  if (result.gaps.length === 0) lines.push("-");
  for (const gap of result.gaps) lines.push(`- [${gap.questionId}]${gap.targetId ? `[target:${gap.targetId}]` : ""} ${gap.reason}`);
  lines.push(`Summary: ${result.summary}`);
  lines.push(`Error: ${result.errorCode ?? "-"}`);
  lines.push(`Session: ${result.sessionFile ?? result.sessionId}`);
  const text = lines.join("\n");
  if (Buffer.byteLength(text, "utf8") > MODEL_RESULT_MAX_BYTES) {
    throw new RangeError(`Serialized FreeContext result exceeds ${MODEL_RESULT_MAX_BYTES} bytes.`);
  }
  return text;
}
