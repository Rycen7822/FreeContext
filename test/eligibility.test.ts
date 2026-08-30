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
  assert.equal(FREECONTEXT_ELIGIBILITY_POLICY.id, "freecontext-eligibility-v4");
  assert.deepEqual(FREECONTEXT_ELIGIBILITY_POLICY.gates.map(({ order }) => order), [1, 2, 3, 4, 5]);
  assert.equal(FREECONTEXT_HOST_ROUTE_METADATA.gates, FREECONTEXT_ELIGIBILITY_POLICY.gates);
  assert.equal(FREECONTEXT_HOST_ROUTE_METADATA.invariants, FREECONTEXT_ELIGIBILITY_POLICY.invariants);
  for (const gate of FREECONTEXT_ELIGIBILITY_POLICY.gates) {
    assert.ok(TOOL_DESCRIPTION.includes(gate.instruction));
  }
  assert.match(TOOL_DESCRIPTION, /one structured path, symbol, or topic fact target/iu);
  assert.match(TOOL_DESCRIPTION, /invocation is not a repository map/iu);
  assert.match(TOOL_DESCRIPTION, /current evidence gap independently/iu);
  assert.match(TOOL_DESCRIPTION, /overall multi-file task does not call automatically/iu);
  assert.doesNotMatch(TOOL_DESCRIPTION, /Familiarity, known files, or keywords never weaken/iu);
  assert.doesNotMatch(TOOL_DESCRIPTION, /at task start|first read-only exploration action/iu);
  assert.match(TOOL_DESCRIPTION, /only a new typed blocker exposed while consuming Evidence or by edit\/check may start another invocation/iu);
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
    assert.equal(decideFreeContextEligibility(facts(selected)).gate, 2);
  }
});

test("one sufficient precise location stays direct before complexity or native escalation", () => {
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
    assert.equal(decision.gate, 1);
  }
  const preciseComplex = decideFreeContextEligibility(facts({
    knownRefs: [{ kind: "path", path: "src/index.ts" }],
    boundedReadSufficient: true,
    crossModuleCallChain: true,
    nativeSearchBatchCount: 3,
  }));
  assert.deepEqual({ outcome: preciseComplex.outcome, gate: preciseComplex.gate }, { outcome: "direct_read", gate: 1 });
  assert.equal(decideFreeContextEligibility(facts({
    knownRefs: [{ kind: "stack", path: "src/index.ts", line: 10 }],
    boundedReadSufficient: false,
  })).outcome, "exact_probe");
  const bareSymbol = decideFreeContextEligibility(facts({
    knownRefs: [{ kind: "symbol", symbol: "run" }],
    boundedReadSufficient: true,
  }));
  assert.deepEqual({ outcome: bareSymbol.outcome, gate: bareSymbol.gate }, { outcome: "exact_probe", gate: 5 });
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
    assert.equal(decision.gate, 3);
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
    assert.equal(decision.gate, 1);
  }
  const unresolved = decideFreeContextEligibility(facts({
    exactCandidateCount: 7,
    knownRefs: [{ kind: "path", path: "src/index.ts" }],
    boundedReadSufficient: false,
  }));
  assert.deepEqual({ outcome: unresolved.outcome, gate: unresolved.gate }, { outcome: "call", gate: 4 });
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

test("reentry round-trips the exact handoff and exposes all origin contracts", () => {
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

  const validOrigins = [
    {
      id: "gap:new-evidence",
      targetId: "new-evidence",
      kind: "contract_unknown" as const,
      scope: { kind: "symbol" as const, symbol: "NewContract", path: "src/contract.ts" },
      requiredFact: "Locate the newly exposed contract dependency.",
      origin: { kind: "evidence_consumption" as const, evidenceIds: ["e1"] },
    },
    {
      id: "gap:new-edit",
      targetId: "new-edit",
      kind: "verification_unknown" as const,
      scope: { kind: "path" as const, path: "test/new-behavior.test.ts" },
      requiredFact: "Locate cross-file verification for the newly edited behavior.",
      origin: { kind: "edit" as const, changedPaths: ["src/implementation.ts"] },
    },
    {
      id: "gap:new-check",
      targetId: "new-check",
      kind: "cross_file_unknown" as const,
      scope: { kind: "symbol" as const, symbol: "CheckContract", path: "src/check.ts" },
      requiredFact: "Locate the contract exposed by the failing check.",
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
      request: withGap({
        ...validOrigins[0]!,
        origin: { kind: "evidence_consumption" as const, evidenceIds: ["e1"], priorGapId: "missing-gap" },
      }),
      reason: "Evidence-origin reentry cited an unknown prior gap.",
    },
    {
      request: {
        ...request,
        reentry: {
          priorHandoff,
          blockingGap: { ...validOrigins[0]!, targetId: "missing-target" },
        },
      },
      reason: "Reentry blocking gap must bind to a current declared target.",
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

  assert.equal(validateFreeContextReentry(withGap({
    id: "gap:rewritten",
    targetId: "old-contract",
    kind: "contract_unknown",
    scope: { kind: "symbol", symbol: "OldContract", path: "src/contract.ts" },
    requiredFact: "Reworded request for the same contract.",
    origin: { kind: "evidence_consumption", evidenceIds: ["e1"] },
  })).reason, "Reentry blocking gap duplicates an existing target and scope.");

  assert.equal(validateFreeContextReentry(withGap({
    id: "gap:file-tail",
    targetId: "file-tail",
    kind: "cross_file_unknown",
    scope: { kind: "path", path: "src/implementation.ts" },
    requiredFact: "Read the changed file tail.",
    origin: { kind: "edit", changedPaths: ["src/implementation.ts"] },
  })).reason, "Edit-origin reentry targets a changed path; read that path directly instead.");

  assert.equal(validateFreeContextReentry(withGap({
    id: "gap:check-path",
    targetId: "check-path",
    kind: "verification_unknown",
    scope: { kind: "path", path: "src/failure.ts" },
    requiredFact: "Read the exact failure path.",
    origin: { kind: "check", check: "Run the focused check.", failureLocation: "src/failure.ts" },
  })).reason, "Check-origin reentry targets the exact failure path; use a bounded direct diagnostic instead.");
});
