import {
  FREECONTEXT_ELIGIBILITY_POLICY,
} from "./contracts.js";
import { isDeepStrictEqual } from "node:util";
import type {
  EvidenceQuestion,
  FreeContextEligibilityGate,
  FreeContextEligibilityOutcome,
  KnownReference,
  FreeContextRequest,
} from "./contracts.js";

export type ForbiddenFreeContextAction = "edit" | "test" | "git" | "package_manager" | "web" | "credentials";

export interface FreeContextEligibilityFacts {
  readonly evidenceQuestions: readonly EvidenceQuestion[];
  readonly knownRefs: readonly KnownReference[];
  readonly crossModuleCallChain: boolean;
  readonly jointConfigCount: number;
  readonly crossDocumentSynthesis: boolean;
  readonly longDocumentMultiFact: boolean;
  readonly sourceBoundPurpose: "planning" | "review" | "diagnosis" | null;
  readonly nativeSearchBatchCount: number;
  readonly distinctNonEvidenceReadPathCount: number;
  readonly boundedReadSufficient: boolean;
  readonly exactCandidateCount: number | null;
  readonly forbiddenActions: readonly ForbiddenFreeContextAction[];
}

export interface FreeContextEligibilityDecision {
  readonly outcome: FreeContextEligibilityOutcome | "forbidden";
  readonly gate: FreeContextEligibilityGate["order"] | null;
  readonly reason: string;
}

export interface FreeContextReentryDecision {
  readonly accepted: boolean;
  readonly reason: string;
}

export function validateFreeContextReentry(
  request: Readonly<FreeContextRequest>,
): Readonly<FreeContextReentryDecision> {
  const reentry = request.reentry;
  if (!reentry) return Object.freeze({ accepted: true, reason: "Initial invocation." });
  const { priorHandoff, blockingGap } = reentry;
  if (priorHandoff.workUnit.outcome !== priorHandoff.outcome.kind || !isDeepStrictEqual(priorHandoff.workUnit, request.workUnit)) {
    return Object.freeze({ accepted: false, reason: "Reentry must preserve the prior work unit and outcome." });
  }
  if (!request.evidenceQuestions.some((question) => question.coverageTargets.some((target) => target.id === blockingGap.targetId))) {
    return Object.freeze({ accepted: false, reason: "Reentry blocking gap must bind to a current declared target." });
  }
  if (blockingGap.id === priorHandoff.id || priorHandoff.blockingGaps.some((gap) => gap.id === blockingGap.id)) {
    return Object.freeze({ accepted: false, reason: "Reentry requires a new blocking gap id." });
  }
  const sameTypedScope = priorHandoff.blockingGaps.some((gap) => isDeepStrictEqual(
    { targetId: gap.targetId, scope: gap.scope },
    { targetId: blockingGap.targetId, scope: blockingGap.scope },
  ));
  if (sameTypedScope) {
    return Object.freeze({ accepted: false, reason: "Rewording an existing typed scope does not create a new blocking gap." });
  }
  if (blockingGap.origin.kind === "evidence_consumption") {
    const origin = blockingGap.origin;
    if (origin.evidenceIds.some((id) => !priorHandoff.evidenceIds.includes(id))) {
      return Object.freeze({ accepted: false, reason: "Evidence-consumption reentry must cite delivered Evidence IDs." });
    }
    if (origin.priorGapId && !priorHandoff.blockingGaps.some((gap) => gap.id === origin.priorGapId)) {
      return Object.freeze({ accepted: false, reason: "Evidence-consumption reentry cited an unknown prior gap." });
    }
  }
  if (blockingGap.origin.kind === "edit" && blockingGap.scope.kind === "path"
      && blockingGap.origin.changedPaths.includes(blockingGap.scope.path)) {
    return Object.freeze({ accepted: false, reason: "Changed-file adjacent context is a bounded direct read, not a reentry gap." });
  }
  return Object.freeze({ accepted: true, reason: "A new typed blocking gap is linked to Evidence consumption, an edit, or a check." });
}

function gate(order: FreeContextEligibilityGate["order"]): FreeContextEligibilityGate {
  const value = FREECONTEXT_ELIGIBILITY_POLICY.gates.find((candidate) => candidate.order === order);
  if (!value) throw new Error(`Missing FreeContext eligibility gate ${order}.`);
  return value;
}

function requiredRoles(questions: readonly EvidenceQuestion[]): ReadonlySet<EvidenceQuestion["role"]> {
  return new Set(questions.filter((question) => question.required).map((question) => question.role));
}

function hasPreciseReference(references: readonly KnownReference[]): boolean {
  return references.some((reference) =>
    reference.kind === "path" || reference.kind === "stack" ||
    (reference.kind === "symbol" && reference.path !== undefined));
}

export function decideFreeContextEligibility(
  facts: Readonly<FreeContextEligibilityFacts>,
): Readonly<FreeContextEligibilityDecision> {
  if (facts.forbiddenActions.length > 0) {
    return Object.freeze({
      outcome: "forbidden",
      gate: null,
      reason: `FreeContext cannot perform: ${[...new Set(facts.forbiddenActions)].sort().join(", ")}.`,
    });
  }
  if (!Number.isInteger(facts.jointConfigCount) || facts.jointConfigCount < 0) {
    throw new RangeError("jointConfigCount must be a non-negative integer.");
  }
  if (!Number.isInteger(facts.nativeSearchBatchCount) || facts.nativeSearchBatchCount < 0 ||
      !Number.isInteger(facts.distinctNonEvidenceReadPathCount) || facts.distinctNonEvidenceReadPathCount < 0) {
    throw new RangeError("Native search batches and distinct read paths must be non-negative integers.");
  }
  if (facts.exactCandidateCount !== null &&
      (!Number.isInteger(facts.exactCandidateCount) || facts.exactCandidateCount < 0)) {
    throw new RangeError("exactCandidateCount must be null or a non-negative integer.");
  }

  const roles = requiredRoles(facts.evidenceQuestions);
  const complex = roles.size >= 2 || facts.crossModuleCallChain || facts.jointConfigCount >= 2 ||
    facts.crossDocumentSynthesis || facts.longDocumentMultiFact || facts.sourceBoundPurpose !== null;
  if (complex) {
    const selected = gate(1);
    return Object.freeze({ outcome: "call", gate: selected.order, reason: selected.instruction });
  }

  const nativeExpansionObserved = facts.nativeSearchBatchCount > 0 || facts.distinctNonEvidenceReadPathCount > 0;
  if (nativeExpansionObserved && !facts.boundedReadSufficient) {
    const selected = gate(2);
    return Object.freeze({ outcome: "call", gate: selected.order, reason: selected.instruction });
  }

  if (facts.exactCandidateCount !== null &&
      !(hasPreciseReference(facts.knownRefs) && facts.boundedReadSufficient)) {
    const selected = gate(3);
    return Object.freeze({ outcome: selected.outcome, gate: selected.order, reason: selected.instruction });
  }

  if (hasPreciseReference(facts.knownRefs) && facts.boundedReadSufficient) {
    const selected = gate(4);
    return Object.freeze({ outcome: "direct_read", gate: selected.order, reason: selected.instruction });
  }

  const selected = gate(5);
  return Object.freeze({ outcome: "exact_probe", gate: selected.order, reason: selected.instruction });
}
