import assert from "node:assert/strict";
import test from "node:test";
import {
  FREECONTEXT_ELIGIBILITY_POLICY,
  FREECONTEXT_HOST_ROUTE_METADATA,
  TOOL_DESCRIPTION,
} from "../src/mcp/contracts.js";
import { decideFreeContextEligibility } from "../src/mcp/eligibility.js";
import type { FreeContextEligibilityFacts } from "../src/mcp/eligibility.js";

const implementationQuestion = {
  id: "implementation",
  role: "implementation" as const,
  question: "Where is this implemented?",
  required: true,
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
});

test("complex scopes call FreeContext before any repository probe", () => {
  const cases: readonly Partial<FreeContextEligibilityFacts>[] = [
    {
      evidenceQuestions: [
        implementationQuestion,
        { id: "tests", role: "test", question: "Where is this tested?", required: true },
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

test("a second search batch or third non-evidence path escalates before direct-read exceptions", () => {
  for (const selected of [
    { nativeSearchBatchCount: 1 },
    { distinctNonEvidenceReadPathCount: 2 },
  ]) {
    const decision = decideFreeContextEligibility(facts({
      knownRefs: [{ kind: "stack", path: "src/index.ts", line: 10 }],
      boundedReadSufficient: true,
      ...selected,
    }));
    assert.equal(decision.outcome, "call");
    assert.equal(decision.gate, 2);
  }
});

test("one exact probe routes zero or three-to-six candidates and directly reads one or two", () => {
  const probe = decideFreeContextEligibility(facts());
  assert.deepEqual({ outcome: probe.outcome, gate: probe.gate }, { outcome: "exact_probe", gate: 5 });
  for (const count of [0, 1, 2, 3, 6]) {
    const decision = decideFreeContextEligibility(facts({
      exactCandidateCount: count,
      knownRefs: [{ kind: "path", path: "src/index.ts" }],
      boundedReadSufficient: true,
    }));
    assert.equal(decision.outcome, count === 0 || count >= 3 ? "call" : "direct_read");
    assert.equal(decision.gate, 3);
  }
  assert.throws(
    () => decideFreeContextEligibility(facts({ exactCandidateCount: 7 })),
    /zero through six/u,
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
