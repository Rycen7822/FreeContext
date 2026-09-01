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
  CoverageTarget,
  FreeContextRecoveryRequest,
} from "./contracts.js";

export type ForbiddenFreeContextAction = "edit" | "test" | "git" | "package_manager" | "web" | "credentials";

export interface FreeContextEligibilityFacts {
  /** Whether the whole next source-understanding phase is expected to cross owners or relationships. */
  readonly concreteExplorationGap: boolean;
  readonly boundedReadSufficient: boolean;
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

export interface FreeContextRecoveryDecision {
  readonly accepted: boolean;
  readonly reason: string;
}

export function validateFreeContextRecovery(
  request: Readonly<FreeContextRequest>,
): Readonly<FreeContextRecoveryDecision> {
  const recovery: Readonly<FreeContextRecoveryRequest> | undefined = request.recovery;
  if (!recovery) return Object.freeze({ accepted: true, reason: "Initial invocation." });
  if (request.reentry) {
    return Object.freeze({ accepted: false, reason: "Recovery cannot be combined with typed reentry." });
  }
  if (!recovery.probePath.trim()) {
    return Object.freeze({ accepted: false, reason: "Recovery requires one exact probe path." });
  }
  return Object.freeze({ accepted: true, reason: "Recovery is bound to the prior not_found session and one exact probe path." });
}

function declaredTargetFor(
  request: Readonly<FreeContextRequest>,
  questionId: string,
  targetId: string,
): Readonly<{ question: Readonly<FreeContextRequest>["evidenceQuestions"][number]; target: Readonly<CoverageTarget> }> | undefined {
  const question = request.evidenceQuestions.find((candidate) => candidate.id === questionId);
  const target = question?.coverageTargets.find((candidate) => candidate.id === targetId);
  return question && target ? { question, target } : undefined;
}

function normalizedFact(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

export function validateFreeContextReentry(
  request: Readonly<FreeContextRequest>,
): Readonly<FreeContextReentryDecision> {
  const reentry = request.reentry;
  if (!reentry) return Object.freeze({ accepted: true, reason: "Initial invocation." });
  const { priorHandoff, blockingGap } = reentry;
  if (!priorHandoff.addressedFacts || priorHandoff.addressedFacts.length === 0) {
    return Object.freeze({ accepted: false, reason: "Reentry priorHandoff must include addressed request facts." });
  }
  if (priorHandoff.workUnit.outcome !== priorHandoff.outcome.kind) {
    return Object.freeze({ accepted: false, reason: "Reentry priorHandoff outcome must match its workUnit." });
  }
  if (!isDeepStrictEqual(priorHandoff.workUnit, request.workUnit)) {
    return Object.freeze({ accepted: false, reason: "Reentry request.workUnit must exactly equal priorHandoff.workUnit." });
  }
  const declared = declaredTargetFor(request, blockingGap.questionId, blockingGap.targetId);
  if (!declared) {
    return Object.freeze({ accepted: false, reason: "Reentry blocking gap must bind to one current question and target." });
  }
  if (!isDeepStrictEqual(declared.target.subject, blockingGap.scope)) {
    return Object.freeze({ accepted: false, reason: "Reentry blocking gap scope must match its declared target." });
  }
  if (normalizedFact(declared.question.question) !== normalizedFact(blockingGap.requiredFact)) {
    return Object.freeze({ accepted: false, reason: "Reentry blocking gap requiredFact must match its current evidence question." });
  }
  if (blockingGap.id === priorHandoff.id || priorHandoff.blockingGaps.some((gap) => gap.id === blockingGap.id)) {
    return Object.freeze({ accepted: false, reason: "Reentry blocking gap id must be new; it cannot repeat the prior handoff." });
  }
  const parentGapId = blockingGap.derivation.kind === "gap_concretization"
    ? blockingGap.derivation.parentGapId
    : null;
  const parentGap = parentGapId !== null
    ? priorHandoff.blockingGaps.find((gap) => gap.id === parentGapId)
    : undefined;
  if (blockingGap.derivation.kind === "handoff_child" &&
      blockingGap.derivation.parentHandoffId !== priorHandoff.id) {
    return Object.freeze({ accepted: false, reason: "Handoff-child reentry must name the copied prior handoff." });
  }
  if (blockingGap.derivation.kind === "gap_concretization" && !parentGap) {
    return Object.freeze({ accepted: false, reason: "Gap concretization must name a gap in the copied prior handoff." });
  }
  const repeatsAddressedFact = priorHandoff.addressedFacts.some((fact) =>
    isDeepStrictEqual(fact.scope, blockingGap.scope) &&
    normalizedFact(fact.requiredFact) === normalizedFact(blockingGap.requiredFact));
  if (repeatsAddressedFact) {
    return Object.freeze({ accepted: false, reason: "Reentry repeats an already addressed scope and normalized fact." });
  }
  if (blockingGap.derivation.kind === "gap_concretization") {
    if (blockingGap.origin.kind !== "edit" && blockingGap.origin.kind !== "check") {
      return Object.freeze({ accepted: false, reason: "Gap concretization must be exposed by an edit or a check." });
    }
    if (parentGap && normalizedFact(blockingGap.requiredFact) === normalizedFact(parentGap.requiredFact)) {
      return Object.freeze({ accepted: false, reason: "Gap concretization must ask a normalized child fact, not repeat the parent gap." });
    }
  }
  if (blockingGap.origin.kind === "evidence_consumption") {
    const origin = blockingGap.origin;
    if (origin.evidenceIds.some((id) => !priorHandoff.evidenceIds.includes(id))) {
      return Object.freeze({ accepted: false, reason: "Evidence-origin reentry must cite Evidence returned in priorHandoff." });
    }
  }
  if (blockingGap.origin.kind === "edit" && blockingGap.scope.kind === "path"
      && blockingGap.origin.changedPaths.includes(blockingGap.scope.path)) {
    return Object.freeze({ accepted: false, reason: "Edit-origin reentry targets a changed path; read that path directly instead." });
  }
  if (blockingGap.origin.kind === "check" && blockingGap.scope.kind === "path"
      && blockingGap.origin.failureLocation === blockingGap.scope.path) {
    return Object.freeze({ accepted: false, reason: "Check-origin reentry targets the exact failure path; use a bounded direct diagnostic instead." });
  }
  return Object.freeze({ accepted: true, reason: `Accepted: ${blockingGap.derivation.kind} is linked to ${blockingGap.origin.kind}.` });
}

function gate(order: FreeContextEligibilityGate["order"]): FreeContextEligibilityGate {
  const value = FREECONTEXT_ELIGIBILITY_POLICY.gates.find((candidate) => candidate.order === order);
  if (!value) throw new Error(`Missing FreeContext eligibility gate ${order}.`);
  return value;
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
  if (typeof facts.concreteExplorationGap !== "boolean" || typeof facts.boundedReadSufficient !== "boolean") {
    throw new TypeError("concreteExplorationGap and boundedReadSufficient must be booleans.");
  }
  if (facts.boundedReadSufficient) {
    const selected = gate(1);
    return Object.freeze({ outcome: "direct_read", gate: selected.order, reason: selected.instruction });
  }

  if (facts.concreteExplorationGap) {
    const selected = gate(2);
    return Object.freeze({ outcome: "call", gate: selected.order, reason: selected.instruction });
  }

  const selected = gate(3);
  return Object.freeze({ outcome: "exact_probe", gate: selected.order, reason: selected.instruction });
}
