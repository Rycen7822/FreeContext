import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  buildFinalizationPacket,
  createSubmitEvidenceTool,
  createTerminalSubmissionState,
  FINALIZATION_SYSTEM_PROMPT,
  finalizationFits,
  latestCompactionSummary,
  observedReadFromToolResult,
  retainedObservedReads,
  submitSchemaTokenDelta,
} from "../src/runtime/finalization.js";
import { baseRequest, topicTarget } from "./helpers.js";

const observedRead = {
  tool: "read" as const,
  path: "src/index.ts",
  startLine: 4,
  endLine: 8,
  content: "[read src/index.ts:4-8]\n4 export const value = 1;",
};

const validArguments = {
  summary: "The implementation is verified.",
  evidence: [{
    question_id: "impl",
    path: "src/index.ts",
    start_line: 4,
    end_line: 8,
    focus_line: 4,
    why: "Defines the exported value.",
  }],
  gaps: [{ question_id: "tests", reason: "No test evidence was observed." }],
};

test("submit_evidence accepts one locally valid observed candidate", async () => {
  const state = createTerminalSubmissionState();
  const tool = createSubmitEvidenceTool({
    Type,
    request: baseRequest(),
    observedReads: () => [observedRead],
    state,
    isFinalizing: () => false,
  });
  const result = await tool.execute("submit-1", validArguments);
  assert.equal(result.terminate, false);
  assert.equal(state.failureKind, null);
  assert.deepEqual(state.failureDetails, []);
  assert.equal(state.candidate?.evidence[0]?.path, "src/index.ts");
  assert.equal(state.candidate?.evidence[0]?.role, "implementation");
  assert.equal((result.details as { readonly tool?: string }).tool, "submit_evidence");
});

test("submit_evidence retries an incomplete structural header and accepts its self-contained range", async () => {
  const state = createTerminalSubmissionState();
  const structuralRead = {
    tool: "read" as const,
    path: "src/result.py",
    startLine: 24,
    endLine: 27,
    content: "[read src/result.py:24-27]\n24: class Result(  # type: ignore[type-var]\n25:     BaseContainer,\n26: ):\n27:     def bind(self): ...",
  };
  const tool = createSubmitEvidenceTool({
    Type,
    request: baseRequest(),
    observedReads: () => [structuralRead],
    state,
    isFinalizing: () => false,
  });
  const incomplete = {
    ...validArguments,
    evidence: [{ ...validArguments.evidence[0], path: "src/result.py", start_line: 24, end_line: 24, focus_line: 24 }],
  };
  await assert.rejects(tool.execute("submit-header", incomplete), /incomplete_structural_evidence/u);
  assert.equal(state.failureKind, null);
  await tool.execute("submit-range", {
    ...incomplete,
    evidence: [{ ...incomplete.evidence[0], end_line: 27 }],
  });
  assert.equal(state.candidate?.evidence[0]?.endLine, 27);

  const finalState = createTerminalSubmissionState();
  const finalTool = createSubmitEvidenceTool({
    Type,
    request: baseRequest(),
    observedReads: () => [structuralRead],
    state: finalState,
    isFinalizing: () => true,
  });
  const finalResult = await finalTool.execute("final-header", incomplete);
  assert.equal(finalResult.terminate, true);
  assert.deepEqual(finalState.candidate?.gaps.map((gap) => gap.questionId), ["tests", "impl"]);
});

test("submit_evidence clips an adjacent merged range to the focus observation", async () => {
  const state = createTerminalSubmissionState();
  const tool = createSubmitEvidenceTool({
    Type,
    request: baseRequest(),
    observedReads: () => [
      { ...observedRead, startLine: 1, endLine: 80 },
      { ...observedRead, startLine: 80, endLine: 160 },
    ],
    state,
    isFinalizing: () => true,
  });
  await tool.execute("submit-adjacent", {
    ...validArguments,
    evidence: [{ ...validArguments.evidence[0], start_line: 77, end_line: 106, focus_line: 94 }],
  });
  assert.deepEqual(
    { startLine: state.candidate?.evidence[0]?.startLine, endLine: state.candidate?.evidence[0]?.endLine },
    { startLine: 80, endLine: 106 },
  );
});

test("submit_evidence canonicalizes descriptive text before storing the private candidate", async () => {
  const state = createTerminalSubmissionState();
  const tool = createSubmitEvidenceTool({
    Type,
    request: baseRequest(),
    observedReads: () => [observedRead],
    state,
    isFinalizing: () => true,
  });
  await tool.execute("submit-normalized", {
    ...validArguments,
    summary: `${"s".repeat(320)}\nextra`,
    evidence: [{ ...validArguments.evidence[0], why: `${"w".repeat(140)}\nextra` }],
    gaps: [{ ...validArguments.gaps[0], reason: `${"r".repeat(140)}\nextra` }],
  });
  assert.equal([...(state.candidate?.summary ?? "")].length, 300);
  assert.equal([...(state.candidate?.evidence[0]?.why ?? "")].length, 120);
  assert.equal([...(state.candidate?.gaps[0]?.reason ?? "")].length, 120);
  assert.equal(JSON.stringify(state.candidate).includes("\\n"), false);
});

test("submit_evidence exposes only portable shape constraints to the provider", () => {
  const tool = createSubmitEvidenceTool({
    Type,
    request: baseRequest(),
    observedReads: () => [observedRead],
    state: createTerminalSubmissionState(),
    isFinalizing: () => false,
  });
  const schema = JSON.stringify(tool.parameters);
  assert.match(tool.description, /at most 6 self-contained observed evidence items.*required allocation.*reserved slots.*never submit a seventh/iu);
  assert.match(tool.description, /existing owner that proves absence as complete negative evidence/iu);
  assert.match(tool.description, /1 reserved slots/iu);
  assert.match(tool.description, /minimumSpans/iu);
  assert.equal(schema.includes('"role"'), false);
  for (const unsupported of ["anyOf", "oneOf", "allOf", "const", "pattern", "minLength", "maxLength", "minimum", "maximum", "maxItems"]) {
    assert.equal(schema.includes(`\"${unsupported}\"`), false, unsupported);
  }
});

test("local submission validation records exact limits removed from the provider schema", async () => {
  const invalidCases = [
    [{ ...validArguments, evidence: Array.from({ length: 7 }, () => validArguments.evidence[0]) }, ["too_many_evidence"]],
    [{ ...validArguments, gaps: Array.from({ length: 7 }, () => validArguments.gaps[0]) }, ["too_many_gaps"]],
    [{ ...validArguments, evidence: [{ ...validArguments.evidence[0], question_id: "bad\nid" }] }, ["invalid_evidence_question_id", "unknown_evidence_question"]],
    [{ ...validArguments, evidence: [{ ...validArguments.evidence[0], path: "" }] }, ["empty_evidence_path", "unobserved_range"]],
    [{ ...validArguments, evidence: [{ ...validArguments.evidence[0], start_line: 0 }] }, ["invalid_evidence_line_numbers", "unobserved_range"]],
    [{ ...validArguments, gaps: [{ ...validArguments.gaps[0], question_id: "bad\nid" }] }, ["invalid_gap_question_id", "unknown_gap_question"]],
  ] as const;
  for (const [index, [invalid, expected]] of invalidCases.entries()) {
    const state = createTerminalSubmissionState();
    const tool = createSubmitEvidenceTool({
      Type,
      request: baseRequest(),
      observedReads: () => [observedRead],
      state,
      isFinalizing: () => true,
    });
    await assert.rejects(tool.execute(`invalid-${index}`, invalid), (error: unknown) => {
      assert.match(String(error), /local semantic/u);
      assert.match(String(error), new RegExp(expected.join("|"), "u"));
      return true;
    });
    assert.equal(state.failureKind, "invalid_arguments");
    assert.deepEqual(state.failureDetails, expected);
  }
});

test("finalizer turns missing allocation into an explicit partial-coverage gap", async () => {
  const request = {
    ...baseRequest(),
    evidenceQuestions: baseRequest().evidenceQuestions.map((question) => (
      question.id === "impl" ? { ...question, minimumSpans: 2 } : question
    )),
  };
  const wideRead = { ...observedRead, endLine: 12 };
  const createTool = (state: ReturnType<typeof createTerminalSubmissionState>) => createSubmitEvidenceTool({
    Type,
    request,
    observedReads: () => [wideRead],
    state,
    isFinalizing: () => true,
  });

  const missing = createTerminalSubmissionState();
  const missingResult = await createTool(missing).execute("missing-secondary", validArguments);
  assert.equal(missingResult.terminate, true);
  assert.equal(missing.failureKind, null);
  assert.deepEqual(missing.failureDetails, []);
  assert.deepEqual(missing.candidate?.gaps.map((gap) => gap.questionId), ["tests", "impl"]);

  const partial = createTerminalSubmissionState();
  await createTool(partial).execute("partial-secondary", {
    ...validArguments,
    gaps: [...validArguments.gaps, { question_id: "impl", reason: "A second owner span was not observed." }],
  });
  assert.deepEqual(partial.candidate?.gaps.map((gap) => gap.questionId), ["tests", "impl"]);

  const complete = createTerminalSubmissionState();
  await createTool(complete).execute("complete-secondary", {
    ...validArguments,
    evidence: [
      ...validArguments.evidence,
      { ...validArguments.evidence[0], start_line: 9, end_line: 12, focus_line: 10 },
    ],
  });
  assert.equal(complete.candidate?.evidence.length, 2);
  assert.deepEqual(complete.candidate?.gaps.map((gap) => gap.questionId), ["tests"]);
});

test("finalizer preserves bounded partial evidence when a required gap remains", async () => {
  const state = createTerminalSubmissionState();
  const requiredRequest = {
    ...baseRequest(),
    evidenceQuestions: [
      { id: "implementation", role: "implementation" as const, question: "Which implementation spans matter?", required: true, minimumSpans: 2, coverageTargets: [topicTarget("implementation-target", "implementation", "behavior")] },
      { id: "caller", role: "caller" as const, question: "Which callers matter?", required: true, minimumSpans: 2, coverageTargets: [topicTarget("caller-target", "callers", "relationship")] },
      { id: "contract", role: "contract" as const, question: "Which contract matters?", required: true, coverageTargets: [topicTarget("contract-target", "contract", "contract")] },
      { id: "tests", role: "test" as const, question: "Which tests matter?", required: true, coverageTargets: [topicTarget("tests-target", "tests", "verification")] },
    ],
  };
  const reads = Array.from({ length: 6 }, (_, index) => ({
    ...observedRead,
    path: `src/evidence-${index}.ts`,
  }));
  const tool = createSubmitEvidenceTool({
    Type,
    request: requiredRequest,
    observedReads: () => reads,
    state,
    isFinalizing: () => true,
  });
  const allocations = ["implementation", "implementation", "implementation", "caller", "caller", "tests"] as const;
  const result = await tool.execute("partial-surplus", {
    summary: "Six observed spans are verified while the contract remains unresolved.",
    evidence: allocations.map((question_id, index) => ({
      ...validArguments.evidence[0],
      question_id,
      path: reads[index]!.path,
    })),
    gaps: [{ question_id: "contract", reason: "No authoritative contract span was observed." }],
  });
  assert.equal(result.terminate, true);
  assert.equal(state.failureKind, null);
  assert.deepEqual(state.failureDetails, []);
  assert.equal(state.candidate?.evidence.length, 6);
  assert.deepEqual(state.candidate?.gaps.map((gap) => gap.questionId), ["contract"]);
});

test("finalizer preserves a semantic gap alongside evidence for the same question", async () => {
  const state = createTerminalSubmissionState();
  const tool = createSubmitEvidenceTool({
    Type,
    request: baseRequest(),
    observedReads: () => [observedRead],
    state,
    isFinalizing: () => true,
  });
  await tool.execute("redundant-gap", {
    ...validArguments,
    evidence: Array.from({ length: 6 }, () => validArguments.evidence[0]),
    gaps: [{ question_id: "impl", reason: "The implementation was not found." }],
  });
  assert.equal(state.failureKind, null);
  assert.equal(state.candidate?.evidence.length, 6);
  assert.deepEqual(state.candidate?.gaps, [{
    questionId: "impl",
    reason: "The implementation was not found.",
  }]);
});

test("finalizer preserves observed evidence and turns an unobserved citation into a gap", async () => {
  const state = createTerminalSubmissionState();
  const tool = createSubmitEvidenceTool({
    Type,
    request: baseRequest(),
    observedReads: () => [observedRead],
    state,
    isFinalizing: () => true,
  });
  const result = await tool.execute("submit-1", {
    ...validArguments,
    evidence: [
      validArguments.evidence[0]!,
      { ...validArguments.evidence[0]!, question_id: "tests", path: "tests/missing.py" },
    ],
  });
  assert.equal(result.terminate, true);
  assert.equal(state.failureKind, null);
  assert.deepEqual(state.failureDetails, []);
  assert.equal(state.candidate?.evidence.length, 1);
  assert.deepEqual(state.candidate?.gaps.map((gap) => gap.questionId), ["tests"]);
});

test("finalizer records bounded semantic rejection categories without argument values", async () => {
  const cases = [
    [{ ...validArguments, evidence: [{ ...validArguments.evidence[0], question_id: "unknown" }] }, "unknown_evidence_question"],
    [{ ...validArguments, evidence: [{ ...validArguments.evidence[0], focus_line: 9 }] }, "focus_outside_range"],
    [{ ...validArguments, gaps: [{ ...validArguments.gaps[0], question_id: "unknown" }] }, "unknown_gap_question"],
  ] as const;
  for (const [index, [invalid, expected]] of cases.entries()) {
    const state = createTerminalSubmissionState();
    const tool = createSubmitEvidenceTool({
      Type,
      request: baseRequest(),
      observedReads: () => [observedRead],
      state,
      isFinalizing: () => true,
    });
    await assert.rejects(tool.execute(`semantic-${index}`, invalid), /local semantic/u);
    assert.deepEqual(state.failureDetails, [expected]);
  }
});

test("read observation extraction excludes errors and truncated output", () => {
  const result = {
    content: [{ type: "text", text: observedRead.content }],
    details: { tool: "read", path: "./src/index.ts", startLine: 4, actualEndLine: 8, truncated: false },
  };
  assert.deepEqual(observedReadFromToolResult("read", result, false), observedRead);
  assert.equal(observedReadFromToolResult("read", { ...result, details: { ...result.details, truncated: true } }, false), null);
  assert.equal(observedReadFromToolResult("read", result, true), null);
  assert.equal(observedReadFromToolResult("rg", result, false), null);
});

test("isolated packet marks exploration complete and omits repository tool origins", () => {
  const messages: AgentMessage[] = [
    { role: "compactionSummary", summary: "old summary", tokensBefore: 100, timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "raw history must not return" }], api: "anthropic-messages", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
    { role: "compactionSummary", summary: "latest summary", tokensBefore: 200, timestamp: 3 },
  ];
  const packet = buildFinalizationPacket(baseRequest(), [observedRead], latestCompactionSummary(messages));
  const parsed = JSON.parse(packet) as Record<string, unknown>;
  assert.equal(parsed.workingSummary, "latest summary");
  assert.deepEqual(parsed.submissionRules, {
    maxItems: { evidence: 6, gaps: 6 },
    requiredMinimumSpans: 1,
    requiredAllocation: [
      { question_id: "impl", role: "implementation", slots: 1, remainingSlots: 1, targets: [{ target_id: "impl-target", slots: 1 }], eligibleObservedSpanIds: [1] },
    ],
    question_id: "exact questions[].id; omit role because the harness derives it",
    citation: "non-empty repository-relative path; integer 1 <= start_line <= focus_line <= end_line <= 10000000; smallest self-contained range within one matching repositoryObservation",
    coverage: "Treat requiredAllocation as reserved quotas: fill every target quota and remaining minimum-spans quota with distinct role-matched observed spans before any surplus. A slot is covered only by self-contained observed evidence that answers the full declared question or target, not a declaration or keyword match. Count evidence and gaps before the call; evidence.length must be at most maxItems.evidence, and when requiredAllocation fills the six evidence slots there is no surplus slot. Cite relevant partial observations instead of replacing their quota with surplus; if a quota still cannot be met, include that exact question ID and target_id in gaps. Test role requires an actual test/spec file or inline test block, never a production helper whose name contains test. Never substitute another role or claim a present role-matched observation is absent.",
  });
  const { tool: _tool, ...modelObservation } = observedRead;
  assert.equal(_tool, "read");
  assert.deepEqual(parsed.repositoryObservations, [{ ...modelObservation, content: "4 export const value = 1;" }]);
  assert.equal(packet.includes("raw history must not return"), false);
  assert.equal(packet.includes("[read src/index.ts:4-8]"), false);
  assert.equal(FINALIZATION_SYSTEM_PROMPT.includes("completed repository exploration"), true);
  assert.equal(FINALIZATION_SYSTEM_PROMPT.includes("Repository tools are unavailable"), true);
  assert.equal(FINALIZATION_SYSTEM_PROMPT.includes("never submit a seventh evidence item"), true);
  assert.equal(FINALIZATION_SYSTEM_PROMPT.includes("submissionRules.requiredAllocation"), true);
  assert.equal(FINALIZATION_SYSTEM_PROMPT.includes("eligibleObservedSpanIds"), true);
  assert.equal(FINALIZATION_SYSTEM_PROMPT.includes("A wider adjacent range is clipped"), true);
  assert.equal(FINALIZATION_SYSTEM_PROMPT.includes("smallest self-contained observed evidence"), true);
  assert.equal(FINALIZATION_SYSTEM_PROMPT.includes("declaration or keyword line alone is insufficient"), true);
  assert.equal(FINALIZATION_SYSTEM_PROMPT.includes("complete negative answer"), true);
  assert.equal(FINALIZATION_SYSTEM_PROMPT.includes("never claim a present role-matched repository observation is absent"), true);

  const quotaRequest = {
    ...baseRequest(),
    evidenceQuestions: [
      { id: "implementation", role: "implementation" as const, question: "Implementation?", required: true, minimumSpans: 2, coverageTargets: [topicTarget("implementation-quota", "implementation", "behavior")] },
      { id: "application", role: "caller" as const, question: "Callers?", required: true, minimumSpans: 2, coverageTargets: [topicTarget("application-quota", "callers", "relationship")] },
      { id: "contract", role: "contract" as const, question: "Contract?", required: true, coverageTargets: [topicTarget("contract-quota", "contract", "contract")] },
      { id: "tests", role: "test" as const, question: "Tests?", required: true, coverageTargets: [topicTarget("tests-quota", "tests", "verification")] },
    ],
  };
  const quotaPacket = JSON.parse(buildFinalizationPacket(quotaRequest, [observedRead], null)) as {
    submissionRules: { requiredAllocation: unknown };
  };
  assert.deepEqual(quotaPacket.submissionRules.requiredAllocation, [
    { question_id: "implementation", role: "implementation", slots: 2, remainingSlots: 2, targets: [{ target_id: "implementation-quota", slots: 1 }], eligibleObservedSpanIds: [1] },
    { question_id: "application", role: "caller", slots: 2, remainingSlots: 2, targets: [{ target_id: "application-quota", slots: 1 }], eligibleObservedSpanIds: [1] },
    { question_id: "contract", role: "contract", slots: 1, remainingSlots: 1, targets: [{ target_id: "contract-quota", slots: 1 }], eligibleObservedSpanIds: [1] },
    { question_id: "tests", role: "test", slots: 1, remainingSlots: 1, targets: [{ target_id: "tests-quota", slots: 1 }], eligibleObservedSpanIds: [1] },
  ]);
});

test("compaction keeps only observations whose tool results remain in effective context", () => {
  const retainedMessage: AgentMessage = {
    role: "toolResult",
    toolCallId: "read-2",
    toolName: "read",
    content: [{ type: "text", text: observedRead.content }],
    isError: false,
    timestamp: 2,
  };
  const pruned = { ...observedRead, path: "src/pruned.ts", content: "[read src/pruned.ts:1-2]\npruned raw output" };
  const effective: AgentMessage[] = [
    { role: "compactionSummary", summary: "summary only", tokensBefore: 100, timestamp: 1 },
    retainedMessage,
  ];
  assert.deepEqual(retainedObservedReads(effective, [pruned, observedRead]), [observedRead]);
});

test("finalizer admission and schema delta use the shared batch counter", async () => {
  const state = createTerminalSubmissionState();
  const tool = createSubmitEvidenceTool({
    Type,
    request: baseRequest(),
    observedReads: () => [observedRead],
    state,
    isFinalizing: () => true,
  });
  const counter = { countBatch: async (texts: readonly string[]) => texts.map((text) => text.length) };
  const packet = buildFinalizationPacket(baseRequest(), [observedRead], null);
  assert.equal(await finalizationFits({ packet, tool, counter, contextWindow: 100_000, reserveTokens: 1_000 }), true);
  assert.equal(await finalizationFits({ packet, tool, counter, contextWindow: 1_000, reserveTokens: 999 }), false);
  assert.ok(await submitSchemaTokenDelta({
    systemPrompt: "system",
    promptText: "prompt",
    repositoryTools: [],
    submitTool: tool,
    counter,
  }) > 0);
});
