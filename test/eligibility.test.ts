import assert from "node:assert/strict";
import test from "node:test";
import {
  FREECONTEXT_ELIGIBILITY_POLICY,
  FREECONTEXT_HOST_ROUTE_METADATA,
  TOOL_DESCRIPTION,
} from "../src/mcp/contracts.js";
import { decideFreeContextEligibility, validateFreeContextReentry } from "../src/mcp/eligibility.js";
import type { FreeContextEligibilityFacts } from "../src/mcp/eligibility.js";
import { baseRequest, topicTarget } from "./helpers.js";

const implementationQuestion = {
  id: "implementation",
  role: "implementation" as const,
  question: "Where is this implemented?",
  required: true,
  coverageTargets: [topicTarget("implementation-target", "implementation", "location")],
};

function facts(overrides: Partial<FreeContextEligibilityFacts> = {}): FreeContextEligibilityFacts {
  return {
    evidenceQuestions: [implementationQuestion],
    knownRefs: [],
    crossModuleCallChain: false,
    jointConfigCount: 0,
    crossDocumentSynthesis: false,
    longDocumentMultiFact: false,
    sourceBoundPurpose: null,
    nativeSearchBatchCount: 0,
    distinctNonEvidenceReadPathCount: 0,
    boundedReadSufficient: false,
    exactCandidateCount: null,
    forbiddenActions: [],
    ...overrides,
  };
}

test("one immutable policy owns gate order, tool text, and host route metadata", () => {
  assert.equal(FREECONTEXT_ELIGIBILITY_POLICY.id, "freecontext-eligibility-v3");
  assert.deepEqual(FREECONTEXT_ELIGIBILITY_POLICY.gates.map(({ order }) => order), [1, 2, 3, 4, 5]);
  assert.equal(FREECONTEXT_HOST_ROUTE_METADATA.gates, FREECONTEXT_ELIGIBILITY_POLICY.gates);
  assert.equal(FREECONTEXT_HOST_ROUTE_METADATA.invariants, FREECONTEXT_ELIGIBILITY_POLICY.invariants);
  for (const gate of FREECONTEXT_ELIGIBILITY_POLICY.gates) {
    assert.ok(TOOL_DESCRIPTION.includes(gate.instruction));
  }
  assert.match(TOOL_DESCRIPTION, /one structured path, symbol, or topic fact target/iu);
  assert.match(TOOL_DESCRIPTION, /first call is not a repository map/iu);
  assert.match(TOOL_DESCRIPTION, /If a listed gap blocks the next action, call gather_context for that gap/iu);
});

test("complex scopes call FreeContext before any repository probe", () => {
  const cases: readonly Partial<FreeContextEligibilityFacts>[] = [
    {
      evidenceQuestions: [
        implementationQuestion,
        { id: "tests", role: "test", question: "Where is this tested?", required: true, coverageTargets: [topicTarget("tests-target", "tests", "verification")] },
      ],
    },
    { crossModuleCallChain: true },
    { jointConfigCount: 2 },
    { crossDocumentSynthesis: true },
    { longDocumentMultiFact: true },
    { sourceBoundPurpose: "planning" },
    { sourceBoundPurpose: "review" },
    { sourceBoundPurpose: "diagnosis" },
  ];
  for (const selected of cases) {
    assert.deepEqual(
      decideFreeContextEligibility(facts(selected)).outcome,
      "call",
      JSON.stringify(selected),
    );
    assert.equal(decideFreeContextEligibility(facts(selected)).gate, 1);
  }
});

test("one precise location stays direct only before native exploration escalates", () => {
  for (const knownRef of [
    { kind: "path" as const, path: "src/index.ts" },
    { kind: "stack" as const, path: "src/index.ts", line: 10 },
    { kind: "symbol" as const, symbol: "run", path: "src/index.ts" },
  ]) {
    const decision = decideFreeContextEligibility(facts({
      knownRefs: [knownRef],
      boundedReadSufficient: true,
    }));
    assert.equal(decision.outcome, "direct_read");
    assert.equal(decision.gate, 4);
  }
  assert.equal(decideFreeContextEligibility(facts({
    knownRefs: [{ kind: "stack", path: "src/index.ts", line: 10 }],
    boundedReadSufficient: false,
  })).outcome, "exact_probe");
});

test("native expansion with an unresolved bounded read escalates before broader exploration", () => {
  for (const selected of [
    { nativeSearchBatchCount: 1, distinctNonEvidenceReadPathCount: 0 },
    { nativeSearchBatchCount: 99, distinctNonEvidenceReadPathCount: 99 },
  ]) {
    const decision = decideFreeContextEligibility(facts({
      knownRefs: [{ kind: "stack", path: "src/index.ts", line: 10 }],
      boundedReadSufficient: false,
      ...selected,
    }));
    assert.equal(decision.outcome, "call");
    assert.equal(decision.gate, 2);
  }
});

test("candidate counts are observations, not a coverage threshold", () => {
  for (const count of [0, 7]) {
    const decision = decideFreeContextEligibility(facts({
      exactCandidateCount: count,
      knownRefs: [{ kind: "path", path: "src/index.ts" }],
      boundedReadSufficient: true,
    }));
    assert.equal(decision.outcome, "direct_read");
    assert.equal(decision.gate, 4);
  }
  const unresolved = decideFreeContextEligibility(facts({
    exactCandidateCount: 7,
    knownRefs: [{ kind: "path", path: "src/index.ts" }],
    boundedReadSufficient: false,
  }));
  assert.deepEqual({ outcome: unresolved.outcome, gate: unresolved.gate }, { outcome: "call", gate: 3 });
  assert.throws(
    () => decideFreeContextEligibility(facts({ exactCandidateCount: -1 })),
    /non-negative integer/u,
  );
  assert.throws(
    () => decideFreeContextEligibility(facts({ nativeSearchBatchCount: -1 })),
    /non-negative integers/u,
  );
});

test("forbidden capabilities never route to the read-only subagent", () => {
  for (const action of ["edit", "test", "git", "package_manager", "web", "credentials"] as const) {
    const decision = decideFreeContextEligibility(facts({ forbiddenActions: [action] }));
    assert.equal(decision.outcome, "forbidden");
    assert.equal(decision.gate, null);
  }
});

test("reentry accepts a new typed blocker and rejects rewritten or changed-file adjacent gaps", () => {
  const request = baseRequest();
  const priorHandoff = {
    id: "handoff:previous",
    workUnit: request.workUnit,
    evidenceIds: ["e1"],
    outcome: { kind: request.workUnit.outcome, instruction: "Use the prior Evidence." },
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
      coverageTargets: [{
        id: blockingGap.targetId,
        subject: blockingGap.scope,
        factKind: "location" as const,
        coverageMode: "single" as const,
      }],
    }],
    reentry: { priorHandoff, blockingGap },
  });

  assert.equal(validateFreeContextReentry(withGap({
    id: "gap:new-verification",
    targetId: "new-verification",
    kind: "verification_unknown",
    scope: { kind: "path", path: "test/new-behavior.test.ts" },
    requiredFact: "Locate cross-file verification for the newly edited behavior.",
    origin: { kind: "edit", changedPaths: ["src/implementation.ts"] },
  })).accepted, true);

  assert.equal(validateFreeContextReentry(withGap({
    id: "gap:rewritten",
    targetId: "old-contract",
    kind: "contract_unknown",
    scope: { kind: "symbol", symbol: "OldContract", path: "src/contract.ts" },
    requiredFact: "Reworded request for the same contract.",
    origin: { kind: "evidence_consumption", evidenceIds: ["e1"] },
  })).accepted, false);

  assert.equal(validateFreeContextReentry(withGap({
    id: "gap:file-tail",
    targetId: "file-tail",
    kind: "cross_file_unknown",
    scope: { kind: "path", path: "src/implementation.ts" },
    requiredFact: "Read the changed file tail.",
    origin: { kind: "edit", changedPaths: ["src/implementation.ts"] },
  })).accepted, false);
});
