import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FreeContextInvocationContext, FreeContextRequest } from "../src/mcp/contracts.js";
import { serializeForModel } from "../src/mcp/contracts.js";
import { compileFreeContextResult } from "../src/output/evidence.js";
import type { ExplorerCandidate, ExplorerCoverageCandidate, ExplorerEvidenceCandidate, ExplorerGapCandidate } from "../src/output/evidence.js";
import type { ObservedRead } from "../src/runtime/finalization.js";
import { topicTarget } from "./helpers.js";

const request = (): FreeContextRequest => ({
  taskText: "Trace the routing implementation and its tests.",
  workUnit: { outcome: "answer", goal: "Trace routing implementation and tests." },
  knownRefs: [{ kind: "path", path: "src/router.ts" }],
  evidenceQuestions: [
    { id: "implementation", role: "implementation", question: "Where is routing implemented?", required: true, coverageTargets: [topicTarget("implementation-target", "routing implementation", "location")] },
    { id: "tests", role: "test", question: "Where is routing tested?", required: true, coverageTargets: [topicTarget("tests-target", "routing tests", "verification")] },
  ],
});

const invocation = (root: string): FreeContextInvocationContext => ({
  invocationId: "invocation-1",
  callId: "call-1",
  workspaceRoot: root,
  workspaceRevision: "revision-1",
  sessionId: "session-1",
  sessionFile: path.join(root, ".freecontext-sessions/session-1.json"),
});

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-compiler-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "test"), { recursive: true });
    await writeFile(path.join(root, "src/router.ts"), Array.from({ length: 160 }, (_, index) => `export const line${index + 1} = ${index + 1};`).join("\n"));
    await writeFile(path.join(root, "test/router.test.ts"), "test('router', () => route());\n");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const candidate = (
  summary: string,
  evidence: readonly ExplorerEvidenceCandidate[],
  gaps: readonly ExplorerGapCandidate[] = [],
  coverage: readonly ExplorerCoverageCandidate[] = [],
): Readonly<ExplorerCandidate> => ({ summary, evidence, gaps, coverage });

const observed = (
  pathValue: string,
  startLine: number,
  endLine: number,
): Readonly<ObservedRead> => ({ tool: "read", path: pathValue, startLine, endLine, content: "observed fixture" });

test("compiler rejects a typed citation outside successful read provenance", async () => withWorkspace(async (root) => {
  const result = await compileFreeContextResult(request(), invocation(root), candidate(
    "Routing evidence was claimed without a read.",
    [{
      role: "implementation",
      questionId: "implementation",
      path: "src/router.ts",
      startLine: 1,
      endLine: 20,
      focusLine: 10,
      why: "Defines routing.",
    }],
  ));
  assert.equal(result.status, "not_found");
  assert.equal(result.gaps[0]?.reason, "Evidence range was not present in a successful read observation.");
}));

test("compiler validates observed spans, crops, orders, and emits a ready result", async () => withWorkspace(async (root) => {
  const evidence: ExplorerEvidenceCandidate[] = [
    { role: "test", questionId: "tests", path: "test/router.test.ts", startLine: 1, endLine: 1, focusLine: 1, why: "Covers routing behavior." },
    { role: "implementation", questionId: "implementation", path: "src/router.ts", startLine: 1, endLine: 120, focusLine: 60, why: "Defines the routing branch." },
  ];
  const result = await compileFreeContextResult(
    request(),
    invocation(root),
    candidate("Routing and tests are verified.", evidence),
    { errorCode: null },
    [observed("test/router.test.ts", 1, 1), observed("src/router.ts", 1, 120)],
  );
  assert.equal(result.status, "ready");
  assert.equal(result.errorCode, null);
  assert.deepEqual(result.evidence.map((item) => item.questionId), ["implementation", "tests"]);
  const first = result.evidence[0];
  assert.ok(first);
  assert.equal(first.endLine - first.startLine + 1, 80);
  assert.equal(first.excerpt, Array.from({ length: 80 }, (_, index) => `export const line${index + 21} = ${index + 21};`).join("\n"));
  assert.equal(result.nextAction.kind, "consume_evidence");
  assert.equal(result.nextAction.reason,
    "Use inline Evidence for the next edit/check; call FreeContext when edit/check exposes a new source-bound gap.");
  assert.deepEqual(result.handoff, {
    id: "handoff:invocation-1",
    workUnit: request().workUnit,
    evidenceIds: ["e1", "e2"],
    outcome: { kind: "answer", instruction: "Proceed with answer: Trace routing implementation and tests." },
    addressedFacts: request().evidenceQuestions.flatMap((question) => question.coverageTargets.map((target) => ({
      questionId: question.id,
      targetId: target.id,
      scope: target.subject,
      requiredFact: question.question,
    }))),
    blockingGaps: [],
  });
  const serialized = serializeForModel(result);
  assert.match(serialized, /\[implementation\]\[implementation\]\[target:implementation-target\] src\/router\.ts:/u);
  assert.match(serialized, /Excerpt \(observed\):\nexport const line21 = 21;/u);
  assert.match(serialized, /Follow nextAction: consume inline Evidence/iu);
}));

test("compiler cannot mark a required multi-span question ready after one narrow item", async () => withWorkspace(async (root) => {
  const adequacyRequest: FreeContextRequest = {
    ...request(),
    evidenceQuestions: request().evidenceQuestions.map((question) => (
      question.id === "implementation" ? { ...question, minimumSpans: 2 } : question
    )),
  };
  const implementation = {
    role: "implementation" as const,
    questionId: "implementation",
    path: "src/router.ts",
    startLine: 1,
    endLine: 20,
    focusLine: 10,
    why: "Defines the routing entry point.",
  };
  const tests = {
    role: "test" as const,
    questionId: "tests",
    path: "test/router.test.ts",
    startLine: 1,
    endLine: 1,
    focusLine: 1,
    why: "Covers routing behavior.",
  };
  const partial = await compileFreeContextResult(
    adequacyRequest,
    invocation(root),
    candidate("One implementation stage is still missing.", [implementation, tests]),
    { errorCode: null },
    [observed("src/router.ts", 1, 20), observed("test/router.test.ts", 1, 1)],
  );
  assert.equal(partial.status, "partial");
  assert.equal(partial.gaps.find((gap) => gap.questionId === "implementation")?.reason,
    "Only 1 of 2 required coverage slots were validated.");
  assert.equal(partial.nextAction.reason,
    "Use Evidence; gaps do not allow replay. Reenter only for a parented child exposed by Evidence/edit/check.");
  assert.deepEqual(partial.handoff?.evidenceIds, ["e1", "e2"]);
  assert.deepEqual(partial.handoff?.blockingGaps.map((gap) => gap.targetId), ["implementation-target"]);

  const complete = await compileFreeContextResult(
    adequacyRequest,
    invocation(root),
    candidate("Both implementation stages and tests are verified.", [
      implementation,
      { ...implementation, startLine: 100, endLine: 120, focusLine: 110, why: "Defines the downstream routing stage." },
      tests,
    ]),
    { errorCode: null },
    [observed("src/router.ts", 1, 20), observed("src/router.ts", 100, 120), observed("test/router.test.ts", 1, 1)],
  );
  assert.equal(complete.status, "ready");
  assert.deepEqual(complete.evidence.map((item) => item.questionId), ["implementation", "implementation", "tests"]);
  assert.deepEqual(complete.gaps, []);
}));

test("compiler gates each required question independently", async () => withWorkspace(async (root) => {
  const implementation: ExplorerEvidenceCandidate = {
    role: "implementation",
    questionId: "implementation",
    path: "src/router.ts",
    startLine: 1,
    endLine: 20,
    focusLine: 10,
    why: "Defines the implementation.",
  };
  const tests: ExplorerEvidenceCandidate = {
    role: "test",
    questionId: "tests",
    path: "test/router.test.ts",
    startLine: 1,
    endLine: 1,
    focusLine: 1,
    why: "Verifies routing.",
  };
  const partial = await compileFreeContextResult(
    request(),
    invocation(root),
    candidate("The test area is still missing.", [implementation]),
    { errorCode: null },
    [observed("src/router.ts", 1, 20)],
  );
  assert.equal(partial.status, "partial");
  assert.equal(partial.gaps.some((gap) => gap.questionId === "tests"), true);

  const ready = await compileFreeContextResult(
    request(),
    invocation(root),
    candidate("Both required areas are covered.", [implementation, tests]),
    { errorCode: null },
    [observed("src/router.ts", 1, 20), observed("test/router.test.ts", 1, 1)],
  );
  assert.equal(ready.status, "ready");
}));

test("compiler marks exhaustive coverage ready only with members and an observed boundary basis", async () => withWorkspace(async (root) => {
  const exhaustiveRequest: FreeContextRequest = {
    ...request(),
    evidenceQuestions: [{
      id: "dialects",
      role: "implementation",
      question: "Which dialect implementations exist?",
      required: true,
      coverageTargets: [topicTarget("dialects-target", "dialect implementations", "presence", "exhaustive")],
    }],
  };
  const boundaryEvidence: ExplorerEvidenceCandidate = {
    role: "implementation",
    questionId: "dialects",
    targetId: "dialects-target",
    path: "src/router.ts",
    startLine: 1,
    endLine: 20,
    focusLine: 10,
    coverageBasis: true,
    why: "Enumerates every registered dialect.",
  };
  const compile = async (members: readonly string[], coverageBasis: boolean) => compileFreeContextResult(
    exhaustiveRequest,
    invocation(root),
    candidate("Dialect coverage.", [{ ...boundaryEvidence, coverageBasis }], [], [{ targetId: "dialects-target", members, gaps: [] }]),
    { errorCode: null },
    [observed("src/router.ts", 1, 20)],
  );

  const ready = await compile(["postgres", "mysql", "gel"], true);
  assert.equal(ready.status, "ready");
  assert.deepEqual(ready.coverage, [{
    targetId: "dialects-target",
    mode: "exhaustive",
    members: ["postgres", "mysql", "gel"],
    basisEvidenceIds: ["e1"],
    gaps: [],
    omittedMembers: 0,
  }]);

  const missingMembers = await compile([], true);
  assert.equal(missingMembers.status, "partial");
  assert.match(missingMembers.coverage?.[0]?.gaps[0] ?? "", /No discovered members/u);

  const missingBasis = await compile(["postgres", "mysql", "gel"], false);
  assert.equal(missingBasis.status, "partial");
  assert.match(missingBasis.coverage?.[0]?.gaps[0] ?? "", /No returned Evidence/u);
}));

test("compiler preserves a required question gap alongside partial evidence", async () => withWorkspace(async (root) => {
  const implementation = {
    role: "implementation" as const,
    questionId: "implementation",
    path: "src/router.ts",
    startLine: 1,
    endLine: 20,
    focusLine: 10,
    why: "Defines one supported routing stage.",
  };
  const tests = {
    role: "test" as const,
    questionId: "tests",
    path: "test/router.test.ts",
    startLine: 1,
    endLine: 1,
    focusLine: 1,
    why: "Covers routing behavior.",
  };
  const result = await compileFreeContextResult(
    request(),
    invocation(root),
    candidate("One requested implementation clause remains unsupported.", [implementation, tests], [
      { questionId: "implementation", reason: "The downstream routing stage remains unresolved." },
    ]),
    { errorCode: null },
    [observed("src/router.ts", 1, 20), observed("test/router.test.ts", 1, 1)],
  );
  assert.equal(result.status, "partial");
  assert.deepEqual(result.gaps, [{
    questionId: "implementation",
    targetId: "implementation-target",
    reason: "The downstream routing stage remains unresolved.",
  }]);
}));

test("compiler maps every explicit target to evidence or a target-scoped gap", async () => withWorkspace(async (root) => {
  const targetedRequest: FreeContextRequest = {
    ...request(),
    evidenceQuestions: [
      { id: "deps", role: "implementation", question: "Where is dependency expansion implemented?", required: true, coverageTargets: [topicTarget("deps", "dependency expansion", "behavior")] },
      { id: "commands", role: "implementation", question: "Where is command expansion implemented?", required: true, coverageTargets: [topicTarget("commands", "command expansion", "behavior")] },
      request().evidenceQuestions[1]!,
    ],
  };
  const dependencyEvidence: ExplorerEvidenceCandidate = {
    role: "implementation",
    questionId: "deps",
    targetId: "deps",
    path: "src/router.ts",
    startLine: 1,
    endLine: 20,
    focusLine: 10,
    why: "Shows dependency expansion.",
  };
  const tests: ExplorerEvidenceCandidate = {
    role: "test",
    questionId: "tests",
    path: "test/router.test.ts",
    startLine: 1,
    endLine: 1,
    focusLine: 1,
    why: "Covers routing behavior.",
  };
  const partial = await compileFreeContextResult(
    targetedRequest,
    invocation(root),
    candidate("Only dependency expansion is verified.", [dependencyEvidence, tests]),
    { errorCode: null },
    [observed("src/router.ts", 1, 20), observed("test/router.test.ts", 1, 1)],
  );
  assert.equal(partial.status, "partial");
  assert.deepEqual(partial.gaps.find((gap) => gap.questionId === "commands"), {
    questionId: "commands",
    targetId: "commands",
    reason: "No validated evidence was returned for this question.",
  });
  const ready = await compileFreeContextResult(
    targetedRequest,
    invocation(root),
    candidate("Both implementation targets are verified.", [
      dependencyEvidence,
      { ...dependencyEvidence, questionId: "commands", targetId: "commands", startLine: 100, endLine: 120, focusLine: 110, why: "Shows command expansion." },
      tests,
    ]),
    { errorCode: null },
    [observed("src/router.ts", 1, 20), observed("src/router.ts", 100, 120), observed("test/router.test.ts", 1, 1)],
  );
  assert.equal(ready.status, "ready");
  assert.deepEqual(ready.evidence.filter((item) => item.role === "implementation").map((item) => item.targetId), ["deps", "commands"]);
  const optional = await compileFreeContextResult(
    {
      ...targetedRequest,
      evidenceQuestions: targetedRequest.evidenceQuestions.map((question) =>
        question.role === "implementation" ? { ...question, required: false } : question),
    },
    invocation(root),
    candidate("Only required test evidence is verified.", [tests]),
    { errorCode: null },
    [observed("test/router.test.ts", 1, 1)],
  );
  assert.equal(optional.status, "ready");
  assert.deepEqual(optional.gaps.filter((gap) => gap.targetId === "deps" || gap.targetId === "commands").map((gap) => gap.targetId), ["deps", "commands"]);
}));

test("compiler rejects production helpers as test evidence and accepts inline test blocks", async () => withWorkspace(async (root) => {
  await writeFile(path.join(root, "src/tester.py"), "def run_tests():\n    return []\n");
  await writeFile(path.join(root, "src/router.rs"), "#[cfg(test)]\nmod tests {\n    #[test]\n    fn routes() {}\n}\n");
  const implementation: ExplorerEvidenceCandidate = {
    role: "implementation", questionId: "implementation", path: "src/router.ts",
    startLine: 1, endLine: 10, focusLine: 5, why: "Defines routing.",
  };
  const productionResult = await compileFreeContextResult(
    request(),
    invocation(root),
    candidate("Production helper was proposed as test evidence.", [
      implementation,
      { role: "test", questionId: "tests", path: "src/tester.py", startLine: 1, endLine: 2, focusLine: 1, why: "Runs checks." },
    ]),
    { errorCode: null },
    [observed("src/router.ts", 1, 10), observed("src/tester.py", 1, 2)],
  );
  assert.equal(productionResult.status, "partial");
  assert.equal(productionResult.gaps.find((gap) => gap.questionId === "tests")?.reason,
    "Evidence range was not an actual test/spec or inline test block.");

  const inlineResult = await compileFreeContextResult(
    request(),
    invocation(root),
    candidate("Routing and inline tests are verified.", [
      implementation,
      { role: "test", questionId: "tests", path: "src/router.rs", startLine: 1, endLine: 5, focusLine: 3, why: "Defines inline tests." },
    ]),
    { errorCode: null },
    [observed("src/router.ts", 1, 10), observed("src/router.rs", 1, 5)],
  );
  assert.equal(inlineResult.status, "ready");
  assert.equal(inlineResult.evidence.find((item) => item.questionId === "tests")?.path, "src/router.rs");
}));

test("compiler allocates six spans across four outcome questions without starving later roles", async () => withWorkspace(async (root) => {
  const evidenceQuestions = [
    { id: "implementation", role: "implementation" as const, question: "Where are both implementation stages?", required: true, minimumSpans: 2, coverageTargets: [topicTarget("implementation-stages", "implementation stages", "behavior")] },
    { id: "application", role: "caller" as const, question: "Where are both application stages?", required: true, minimumSpans: 2, coverageTargets: [topicTarget("application-stages", "application stages", "relationship")] },
    { id: "contract", role: "contract" as const, question: "What contract applies?", required: true, coverageTargets: [topicTarget("contract-target", "routing contract", "contract")] },
    { id: "tests", role: "test" as const, question: "What tests apply?", required: true, coverageTargets: [topicTarget("tests-target-2", "routing tests", "verification")] },
  ];
  const evidence = [
    { role: "implementation" as const, questionId: "implementation", path: "src/router.ts", startLine: 1, endLine: 20, focusLine: 10, why: "Defines the entry stage." },
    { role: "implementation" as const, questionId: "implementation", path: "src/router.ts", startLine: 40, endLine: 60, focusLine: 50, why: "Defines the state stage." },
    { role: "caller" as const, questionId: "application", path: "src/router.ts", startLine: 70, endLine: 90, focusLine: 80, why: "Calls the entry stage." },
    { role: "caller" as const, questionId: "application", path: "src/router.ts", startLine: 110, endLine: 130, focusLine: 120, why: "Consumes the state stage." },
    { role: "contract" as const, questionId: "contract", path: "src/router.ts", startLine: 140, endLine: 150, focusLine: 145, why: "Defines the contract." },
    { role: "test" as const, questionId: "tests", path: "test/router.test.ts", startLine: 1, endLine: 1, focusLine: 1, why: "Tests the route." },
  ];
  const result = await compileFreeContextResult(
    { ...request(), evidenceQuestions },
    invocation(root),
    candidate("Both implementation and application stages, the contract, and tests were observed.", evidence),
    { errorCode: null },
    [observed("src/router.ts", 1, 150), observed("test/router.test.ts", 1, 1)],
  );
  assert.equal(result.status, "ready");
  assert.equal(result.evidence.length, 6);
  assert.deepEqual(result.evidence.map((item) => item.questionId),
    ["implementation", "implementation", "application", "application", "contract", "tests"]);
  assert.ok(result.evidence.reduce((total, item) => total + item.endLine - item.startLine + 1, 0) <= 320);
}));

test("compiler turns role mismatch and rejected generated paths into explicit gaps", async () => withWorkspace(async (root) => {
  const evidence: ExplorerEvidenceCandidate[] = [
    { role: "implementation", questionId: "implementation", path: "src/router.ts", startLine: 10, endLine: 20, focusLine: 15, why: "Defines routing." },
    { role: "caller", questionId: "tests", path: "test/router.test.ts", startLine: 1, endLine: 1, focusLine: 1, why: "Wrong requested role." },
    { role: "test", questionId: "tests", path: "dist/router.test.ts", startLine: 1, endLine: 1, focusLine: 1, why: "Generated output." },
  ];
  const result = await compileFreeContextResult(
    request(),
    invocation(root),
    candidate("Only one valid item remains.", evidence, [{ questionId: "tests", reason: "Test evidence remains unresolved." }]),
    { errorCode: null },
    [observed("src/router.ts", 10, 20), observed("dist/router.test.ts", 1, 1)],
  );
  assert.equal(result.status, "partial");
  assert.equal(result.errorCode, null);
  assert.deepEqual(result.evidence.map((item) => item.questionId), ["implementation"]);
  assert.deepEqual(result.gaps, [{ questionId: "tests", targetId: "tests-target", reason: "Test evidence remains unresolved." }]);
  assert.equal(result.nextAction.reason, "Use Evidence; gaps do not allow replay. Reenter only for a parented child exposed by Evidence/edit/check.");
}));

test("compiler does not treat a trailing newline as an extra citable line", async () => withWorkspace(async (root) => {
  const result = await compileFreeContextResult(
    request(),
    invocation(root),
    candidate("The requested range is outside the test file.", [
      { role: "test", questionId: "tests", path: "test/router.test.ts", startLine: 2, endLine: 2, focusLine: 2, why: "This line does not exist." },
    ], [{ questionId: "implementation", reason: "Implementation was not inspected." }]),
    { errorCode: null },
    [observed("test/router.test.ts", 2, 2)],
  );
  assert.equal(result.status, "not_found");
  assert.deepEqual(result.gaps.find((gap) => gap.questionId === "tests"), {
    questionId: "tests",
    targetId: "tests-target",
    reason: "Evidence range exceeded the file length.",
  });
}));

test("normal empty evidence is not_found while malformed output is failed", async () => withWorkspace(async (root) => {
  const notFound = await compileFreeContextResult(request(), invocation(root), candidate(
    "No matching implementation was found.",
    [],
    [
      { questionId: "implementation", reason: "No matching implementation." },
      { questionId: "tests", reason: "No matching tests." },
    ],
  ));
  assert.equal(notFound.status, "not_found");
  assert.equal(notFound.errorCode, null);
  assert.equal(notFound.nextAction.kind, "exact_probe");
  assert.deepEqual(notFound.nextAction.recovery, {
    priorSessionId: "session-1",
  });
  assert.match(serializeForModel(notFound), /one exact non-broad path or symbol probe and read at most one candidate path/iu);
  assert.match(serializeForModel(notFound), /Recovery contract: after the exact probe, call gather_context with only/iu);
  assert.match(serializeForModel(notFound), /workspace-relative probed path/iu);

  const failed = await compileFreeContextResult(
    request(),
    invocation(root),
    null,
    { errorCode: "INTERNAL_ERROR", reason: "Terminal submission was missing." },
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "INTERNAL_ERROR");
  assert.equal(failed.evidence.length, 0);
}));

test("compiler keeps the canonical text within 8 KiB", async () => withWorkspace(async (root) => {
  const segments = Array.from({ length: 80 }, (_, index) => `segment-${index.toString().padStart(3, "0")}`);
  const directory = path.join(root, ...segments);
  await mkdir(directory, { recursive: true });
  const relativeDirectory = path.relative(root, directory).split(path.sep).join("/");
  const sizeRequest: FreeContextRequest = {
    ...request(),
    evidenceQuestions: Array.from({ length: 6 }, (_, index) => ({
      id: `q${index + 1}`,
      role: "implementation" as const,
      question: `Where is routing stage ${index + 1} implemented?`,
      required: true,
      coverageTargets: [topicTarget(`q${index + 1}-target`, `routing stage ${index + 1}`, "location")],
    })),
  };
  const evidence: ExplorerEvidenceCandidate[] = [];
  const reads: ObservedRead[] = [];
  for (let index = 0; index < 6; index += 1) {
    const filename = `router-${index}.ts`;
    const content = [
      `class Router${index} {`,
      ...Array.from({ length: 40 }, (_, line) => `  readonly segment${line} = "payload-${index}-${line}-${"x".repeat(24)}";`),
      "}",
    ].join("\n");
    await writeFile(path.join(directory, filename), `${content}\n`);
    const relativePath = `${relativeDirectory}/${filename}`;
    evidence.push({
      role: "implementation",
      questionId: `q${index + 1}`,
      path: relativePath,
      startLine: 1,
      endLine: 42,
      focusLine: 1,
      why: `${"detail ".repeat(20)}${index}`,
    });
    reads.push(observed(relativePath, 1, 42));
  }
  const result = await compileFreeContextResult(
    sizeRequest,
    invocation(root),
    candidate(`${"summary ".repeat(60)}`, evidence),
    { errorCode: null },
    reads,
  );
  assert.equal(result.status, "partial");
  assert.ok(result.evidence.length >= 1 && result.evidence.length < 6);
  assert.ok(result.evidence.every((item) => item.startLine < item.endLine && item.excerpt?.endsWith("}")));
  assert.ok(result.gaps.some((gap) => /omitted rather than truncated/u.test(gap.reason)));
  assert.ok(Buffer.byteLength(serializeForModel(result), "utf8") <= 8_192);
}));

test("compiler preserves post-link reentry action when exhaustive basis evidence cannot fit", async () => withWorkspace(async (root) => {
  await writeFile(path.join(root, "test/router.test.ts"), `${"coverage-boundary ".repeat(200)}\n`);
  const exhaustiveRequest: FreeContextRequest = {
    ...request(),
    evidenceQuestions: [{
      id: "members",
      role: "implementation",
      question: "Which registered members exist?",
      required: true,
      coverageTargets: [topicTarget("members-target", "registered members", "presence", "exhaustive")],
    }],
  };
  const members = Array.from({ length: 64 }, (_, index) => `member-${index.toString().padStart(2, "0")}-${"x".repeat(80)}`);
  const result = await compileFreeContextResult(
    exhaustiveRequest,
    invocation(root),
    candidate("Registered members.", [{
      role: "implementation",
      questionId: "members",
      targetId: "members-target",
      path: "src/router.ts",
      startLine: 1,
      endLine: 20,
      focusLine: 10,
      why: "Provides a retained member implementation span.",
    }, {
      role: "implementation",
      questionId: "members",
      targetId: "members-target",
      path: "test/router.test.ts",
      startLine: 1,
      endLine: 1,
      focusLine: 1,
      coverageBasis: true,
      why: "Enumerates the complete registry boundary.",
    }], [], [{ targetId: "members-target", members, gaps: [] }]),
    { errorCode: null },
    [observed("src/router.ts", 1, 20), observed("test/router.test.ts", 1, 1)],
  );
  assert.equal(result.status, "partial");
  assert.ok(result.evidence.some((item) => item.path === "src/router.ts"));
  assert.ok(result.coverage?.[0]?.basisEvidenceIds.length === 0);
  assert.equal(result.coverage?.[0]?.omittedMembers, 0);
  assert.match(result.coverage?.[0]?.gaps[0] ?? "", /Enumeration-boundary Evidence was omitted/u);
  assert.ok(result.gaps.some((gap) => gap.targetId === "members-target"));
  assert.ok(result.handoff?.blockingGaps.some((gap) => gap.targetId === "members-target"));
  assert.equal(result.nextAction.reason, "Consume inline Evidence; execute the handoff; reenter only if it exposes a new typed blocking gap.");
  assert.equal(result.handoff?.workUnit.outcome, exhaustiveRequest.workUnit.outcome);
  assert.equal(result.handoff?.workUnit.goal, exhaustiveRequest.workUnit.goal);
  assert.ok(Buffer.byteLength(serializeForModel(result), "utf8") <= 8_192);
}));
