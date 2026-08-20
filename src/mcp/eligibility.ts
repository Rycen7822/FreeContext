import {
  FREECONTEXT_ELIGIBILITY_POLICY,
} from "./contracts.js";
import type {
  EvidenceQuestion,
  FreeContextEligibilityGate,
  FreeContextEligibilityOutcome,
  KnownReference,
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
      (!Number.isInteger(facts.exactCandidateCount) || facts.exactCandidateCount < 0 || facts.exactCandidateCount > 6)) {
    throw new RangeError("exactCandidateCount must be null or an integer from zero through six.");
  }

  const roles = requiredRoles(facts.evidenceQuestions);
  const complex = roles.size >= 2 || facts.crossModuleCallChain || facts.jointConfigCount >= 2 ||
    facts.crossDocumentSynthesis || facts.longDocumentMultiFact || facts.sourceBoundPurpose !== null;
  if (complex) {
    const selected = gate(1);
    return Object.freeze({ outcome: "call", gate: selected.order, reason: selected.instruction });
  }

  if (facts.nativeSearchBatchCount >= 1 || facts.distinctNonEvidenceReadPathCount >= 2) {
    const selected = gate(2);
    return Object.freeze({ outcome: "call", gate: selected.order, reason: selected.instruction });
  }

  if (facts.exactCandidateCount !== null) {
    const selected = gate(3);
    return Object.freeze({
      outcome: facts.exactCandidateCount === 0 || facts.exactCandidateCount >= 3 ? "call" : "direct_read",
      gate: selected.order,
      reason: selected.instruction,
    });
  }

  if (hasPreciseReference(facts.knownRefs) && facts.boundedReadSufficient) {
    const selected = gate(4);
    return Object.freeze({ outcome: "direct_read", gate: selected.order, reason: selected.instruction });
  }

  const selected = gate(5);
  return Object.freeze({ outcome: "exact_probe", gate: selected.order, reason: selected.instruction });
}
