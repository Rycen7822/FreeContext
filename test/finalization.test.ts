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
import { baseRequest } from "./helpers.js";

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
  assert.equal(result.terminate, true);
  assert.equal(state.failureKind, null);
  assert.deepEqual(state.failureDetails, []);
  assert.equal(state.candidate?.evidence[0]?.path, "src/index.ts");
  assert.equal(state.candidate?.evidence[0]?.role, "implementation");
  assert.equal((result.details as { readonly tool?: string }).tool, "submit_evidence");
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
  assert.equal(schema.includes('"role"'), false);
  for (const unsupported of ["anyOf", "oneOf", "allOf", "const", "pattern", "minLength", "maxLength", "minimum", "maximum", "maxItems"]) {
    assert.equal(schema.includes(`\"${unsupported}\"`), false, unsupported);
  }
});

test("local submission validation records exact limits removed from the provider schema", async () => {
  const invalidCases = [
    [{ ...validArguments, evidence: Array.from({ length: 7 }, () => validArguments.evidence[0]) }, ["too_many_evidence"]],
    [{ ...validArguments, gaps: Array.from({ length: 6 }, () => validArguments.gaps[0]) }, ["too_many_gaps"]],
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
    await assert.rejects(tool.execute(`invalid-${index}`, invalid), /local semantic/u);
    assert.equal(state.failureKind, "invalid_arguments");
    assert.deepEqual(state.failureDetails, expected);
  }
});

test("finalizer rejects unobserved evidence and records invalid_arguments", async () => {
  const state = createTerminalSubmissionState();
  const tool = createSubmitEvidenceTool({
    Type,
    request: baseRequest(),
    observedReads: () => [],
    state,
    isFinalizing: () => true,
  });
  await assert.rejects(tool.execute("submit-1", validArguments), /observed-read validation/u);
  assert.equal(state.candidate, null);
  assert.equal(state.failureKind, "invalid_arguments");
  assert.deepEqual(state.failureDetails, ["unobserved_range"]);
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
    maxItems: { evidence: 6, gaps: 5 },
    question_id: "exact questions[].id; omit role because the harness derives it",
    citation: "non-empty repository-relative path; integer 1 <= start_line <= focus_line <= end_line <= 10000000; range within one matching repositoryObservation",
    coverage: "For each required question, cite defining spans for all named concerns; otherwise omit its evidence and gap it. Do this before extras; summary uses only cited components.",
  });
  const { tool: _tool, ...modelObservation } = observedRead;
  assert.equal(_tool, "read");
  assert.deepEqual(parsed.repositoryObservations, [{ ...modelObservation, content: "4 export const value = 1;" }]);
  assert.equal(packet.includes("raw history must not return"), false);
  assert.equal(packet.includes("[read src/index.ts:4-8]"), false);
  assert.equal(FINALIZATION_SYSTEM_PROMPT.includes("completed repository exploration"), true);
  assert.equal(FINALIZATION_SYSTEM_PROMPT.includes("Repository tools are unavailable"), true);
  assert.equal(FINALIZATION_SYSTEM_PROMPT.includes("for every named concern"), true);
  assert.equal(FINALIZATION_SYSTEM_PROMPT.includes("omit that question's citations and gap it"), true);
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
