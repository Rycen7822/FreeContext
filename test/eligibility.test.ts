import assert from "node:assert/strict";
import test from "node:test";
import {
  FREECONTEXT_ELIGIBILITY_POLICY,
  FREECONTEXT_HOST_ROUTE_METADATA,
  TOOL_DESCRIPTION,
} from "../src/mcp/contracts.js";
import { decideFreeContextEligibility, validateFreeContextReentry } from "../src/mcp/eligibility.js";
import type { FreeContextEligibilityFacts } from "../src/mcp/eligibility.js";
import type { ReentryBlockingGap } from "../src/mcp/contracts.js";
import { baseRequest, topicTarget } from "./helpers.js";

function facts(overrides: Partial<FreeContextEligibilityFacts> = {}): FreeContextEligibilityFacts {
  return {
    concreteExplorationGap: false,
    boundedReadSufficient: false,
    forbiddenActions: [],
    ...overrides,
  };
}

test("one immutable policy owns gate order, tool text, and host route metadata", () => {
  assert.equal(FREECONTEXT_ELIGIBILITY_POLICY.id, "freecontext-eligibility-v7");
  assert.deepEqual(FREECONTEXT_ELIGIBILITY_POLICY.gates.map(({ order }) => order), [1, 2, 3]);
  assert.equal(FREECONTEXT_HOST_ROUTE_METADATA.gates, FREECONTEXT_ELIGIBILITY_POLICY.gates);
  assert.equal(FREECONTEXT_HOST_ROUTE_METADATA.invariants, FREECONTEXT_ELIGIBILITY_POLICY.invariants);
  assert.ok([...TOOL_DESCRIPTION].length <= 1_200);
  assert.match(TOOL_DESCRIPTION, /whole next source-understanding question or phase/iu);
  assert.match(TOOL_DESCRIPTION, /Gate 1:.*one or two small bounded reads.*exact path.*symbol.*local failure.*diff\/status.*edit.*test.*direct check/iu);
  assert.match(TOOL_DESCRIPTION, /Gate 2:.*before search or reading.*multiple non-adjacent owners or relationships.*one role\+question item per required area/iu);
  assert.match(TOOL_DESCRIPTION, /Gate 3:.*local whole-question probe.*task start.*phase change.*complexity.*probability/iu);
  assert.match(TOOL_DESCRIPTION, /Caller is relationship\+exhaustive.*single coverage/iu);
  assert.match(TOOL_DESCRIPTION, /planned cross-module consistency audit.*even without failure.*reentry is optional/iu);
  assert.match(TOOL_DESCRIPTION, /atomic and read-only.*partial Evidence/iu);
});

test("only a concrete multi-file exploration gap calls FreeContext", () => {
  const decision = decideFreeContextEligibility(facts({ concreteExplorationGap: true }));
  assert.deepEqual({ outcome: decision.outcome, gate: decision.gate }, { outcome: "call", gate: 2 });
});

test("complexity and phase changes alone stay native", () => {
  const decision = decideFreeContextEligibility(facts());
  assert.deepEqual({ outcome: decision.outcome, gate: decision.gate }, { outcome: "exact_probe", gate: 3 });
});

test("one sufficient bounded location stays direct before the concrete-gap decision", () => {
  const decision = decideFreeContextEligibility(facts({
    boundedReadSufficient: true,
    concreteExplorationGap: true,
  }));
  assert.deepEqual({ outcome: decision.outcome, gate: decision.gate }, { outcome: "direct_read", gate: 1 });
});

test("invalid route facts fail closed", () => {
  assert.throws(
    () => decideFreeContextEligibility(facts({ concreteExplorationGap: undefined as never })),
    /must be booleans/u,
  );
});

test("forbidden capabilities never route to the read-only subagent", () => {
  for (const action of ["edit", "test", "git", "package_manager", "web", "credentials"] as const) {
    const decision = decideFreeContextEligibility(facts({ forbiddenActions: [action] }));
    assert.equal(decision.outcome, "forbidden");
    assert.equal(decision.gate, null);
  }
});

test("reentry round-trips the exact handoff and exposes all origin contracts", () => {
  const request = baseRequest();
  const priorHandoff = {
    id: "handoff:previous",
    workUnit: request.workUnit,
    evidenceIds: ["e1"],
    outcome: { kind: request.workUnit.outcome, instruction: "Use the prior Evidence." },
    addressedFacts: [{
      questionId: "old-question",
      targetId: "old-contract",
      scope: { kind: "symbol" as const, symbol: "OldContract", path: "src/contract.ts" },
      requiredFact: "Determine the old contract.",
    }],
    blockingGaps: [{
      id: "gap:old-contract",
      targetId: "old-contract",
      kind: "contract_unknown" as const,
      scope: { kind: "symbol" as const, symbol: "OldContract", path: "src/contract.ts" },
      requiredFact: "Determine the old contract.",
    }],
  };
  const withGap = (blockingGap: NonNullable<typeof request.reentry>["blockingGap"]) => ({
    ...request,
    evidenceQuestions: [{
      ...request.evidenceQuestions[0]!,
      question: blockingGap.requiredFact,
      coverageTargets: [{
        id: blockingGap.targetId,
        subject: blockingGap.scope,
        factKind: "location" as const,
        coverageMode: "single" as const,
      }],
    }],
    reentry: { priorHandoff, blockingGap },
  });

  const validOrigins = [
    {
      id: "gap:new-evidence",
      questionId: "impl",
      targetId: "new-evidence",
      kind: "contract_unknown" as const,
      scope: { kind: "symbol" as const, symbol: "NewContract", path: "src/contract.ts" },
      requiredFact: "Locate the newly exposed contract dependency.",
      derivation: { kind: "handoff_child" as const, parentHandoffId: priorHandoff.id },
      origin: { kind: "evidence_consumption" as const, evidenceIds: ["e1"] },
    },
    {
      id: "gap:new-edit",
      questionId: "impl",
      targetId: "new-edit",
      kind: "verification_unknown" as const,
      scope: { kind: "path" as const, path: "test/new-behavior.test.ts" },
      requiredFact: "Locate cross-file verification for the newly edited behavior.",
      derivation: { kind: "handoff_child" as const, parentHandoffId: priorHandoff.id },
      origin: { kind: "edit" as const, changedPaths: ["src/implementation.ts"] },
    },
    {
      id: "gap:new-check",
      questionId: "impl",
      targetId: "new-check",
      kind: "cross_file_unknown" as const,
      scope: { kind: "symbol" as const, symbol: "CheckContract", path: "src/check.ts" },
      requiredFact: "Locate the contract exposed by the failing check.",
      derivation: { kind: "handoff_child" as const, parentHandoffId: priorHandoff.id },
      origin: { kind: "check" as const, check: "Run the focused contract check.", failureLocation: "test/check.test.ts:12" },
    },
  ] satisfies ReentryBlockingGap[];
  for (const blockingGap of validOrigins) {
    assert.equal(validateFreeContextReentry(withGap(blockingGap)).accepted, true, blockingGap.origin.kind);
  }

  const invalidOrigins = [
    {
      request: withGap({
        ...validOrigins[0]!,
        origin: { kind: "evidence_consumption" as const, evidenceIds: ["missing-evidence"] },
      }),
      reason: "Evidence-origin reentry must cite Evidence returned in priorHandoff.",
    },
    {
      request: withGap({ ...validOrigins[0]!, derivation: { kind: "gap_concretization" as const, parentGapId: "missing-gap" } }),
      reason: "Gap concretization must name a gap in the copied prior handoff.",
    },
    {
      request: {
        ...request,
        reentry: {
          priorHandoff,
          blockingGap: { ...validOrigins[0]!, targetId: "missing-target" },
        },
      },
      reason: "Reentry blocking gap must bind to one current question and target.",
    },
  ];
  for (const invalid of invalidOrigins) assert.equal(validateFreeContextReentry(invalid.request).reason, invalid.reason);

  const mismatch = {
    ...withGap(validOrigins[0]!),
    workUnit: { ...request.workUnit, goal: "A different work unit." },
  };
  assert.deepEqual(validateFreeContextReentry(mismatch), {
    accepted: false,
    reason: "Reentry request.workUnit must exactly equal priorHandoff.workUnit.",
  });

  const forgedBlockingFact = withGap(validOrigins[0]!);
  assert.equal(validateFreeContextReentry({
    ...forgedBlockingFact,
    reentry: {
      ...forgedBlockingFact.reentry,
      blockingGap: { ...forgedBlockingFact.reentry.blockingGap, requiredFact: "A forged child fact not sent to the explorer." },
    },
  }).reason, "Reentry blocking gap requiredFact must match its current evidence question.");

  assert.equal(validateFreeContextReentry(withGap({
    id: "gap:rewritten",
    questionId: "impl",
    targetId: "old-contract",
    kind: "contract_unknown",
    scope: { kind: "symbol", symbol: "OldContract", path: "src/contract.ts" },
    requiredFact: "  DETERMINE   THE OLD CONTRACT. ",
    derivation: { kind: "handoff_child", parentHandoffId: priorHandoff.id },
    origin: { kind: "evidence_consumption", evidenceIds: ["e1"] },
  })).reason, "Reentry repeats an already addressed scope and normalized fact.");

  assert.equal(validateFreeContextReentry(withGap({
    id: "gap:changed-target-handle",
    questionId: "impl",
    targetId: "renamed-contract-target",
    kind: "contract_unknown",
    scope: { kind: "symbol", symbol: "OldContract", path: "src/contract.ts" },
    requiredFact: "Determine the old contract.",
    derivation: { kind: "handoff_child", parentHandoffId: priorHandoff.id },
    origin: { kind: "evidence_consumption", evidenceIds: ["e1"] },
  })).reason, "Reentry repeats an already addressed scope and normalized fact.");

  const changedQuestionHandle = withGap({
    id: "gap:changed-question-handle",
    questionId: "renamed-question",
    targetId: "old-contract",
    kind: "contract_unknown",
    scope: { kind: "symbol", symbol: "OldContract", path: "src/contract.ts" },
    requiredFact: "Determine the old contract.",
    derivation: { kind: "handoff_child", parentHandoffId: priorHandoff.id },
    origin: { kind: "evidence_consumption", evidenceIds: ["e1"] },
  });
  assert.equal(validateFreeContextReentry({
    ...changedQuestionHandle,
    evidenceQuestions: changedQuestionHandle.evidenceQuestions.map((question) => ({
      ...question,
      id: "renamed-question",
    })),
  }).reason, "Reentry repeats an already addressed scope and normalized fact.");

  const concretizedChild = {
    id: "gap:concrete-check-child",
    questionId: "impl",
    targetId: "old-contract",
    kind: "contract_unknown" as const,
    scope: { kind: "symbol" as const, symbol: "OldContract", path: "src/contract.ts" },
    requiredFact: "Determine which caller violates OldContract after the focused check.",
    derivation: { kind: "gap_concretization" as const, parentGapId: "gap:old-contract" },
    origin: { kind: "check" as const, check: "Run the focused contract check." },
  };
  assert.equal(validateFreeContextReentry(withGap(concretizedChild)).accepted, true);
  assert.equal(validateFreeContextReentry(withGap({
    ...concretizedChild,
    id: "gap:same-fact",
    requiredFact: "Determine the old contract.",
  })).reason, "Reentry repeats an already addressed scope and normalized fact.");

  assert.equal(validateFreeContextReentry(withGap({
    id: "gap:file-tail",
    questionId: "impl",
    targetId: "file-tail",
    kind: "cross_file_unknown",
    scope: { kind: "path", path: "src/implementation.ts" },
    requiredFact: "Read the changed file tail.",
    derivation: { kind: "handoff_child", parentHandoffId: priorHandoff.id },
    origin: { kind: "edit", changedPaths: ["src/implementation.ts"] },
  })).reason, "Edit-origin reentry targets a changed path; read that path directly instead.");

  assert.equal(validateFreeContextReentry(withGap({
    id: "gap:check-path",
    questionId: "impl",
    targetId: "check-path",
    kind: "verification_unknown",
    scope: { kind: "path", path: "src/failure.ts" },
    requiredFact: "Read the exact failure path.",
    derivation: { kind: "handoff_child", parentHandoffId: priorHandoff.id },
    origin: { kind: "check", check: "Run the focused check.", failureLocation: "src/failure.ts" },
  })).reason, "Check-origin reentry targets the exact failure path; use a bounded direct diagnostic instead.");
});
