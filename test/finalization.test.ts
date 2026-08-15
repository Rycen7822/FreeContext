import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  buildFinalizationPacket,
  createSubmitEvidenceTool,
  createTerminalSubmissionState,
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
    role: "implementation" as const,
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
  assert.equal(state.candidate?.evidence[0]?.path, "src/index.ts");
  assert.equal((result.details as { readonly tool?: string }).tool, "submit_evidence");
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
  for (const unsupported of ["anyOf", "oneOf", "allOf", "const", "pattern", "minLength", "maxLength", "minimum", "maximum", "maxItems"]) {
    assert.equal(schema.includes(`\"${unsupported}\"`), false, unsupported);
  }
});

test("local submission validation retains limits removed from the provider schema", async () => {
  const invalidCases = [
    { ...validArguments, summary: "x".repeat(301) },
    { ...validArguments, evidence: Array.from({ length: 7 }, () => validArguments.evidence[0]) },
    { ...validArguments, gaps: Array.from({ length: 6 }, () => validArguments.gaps[0]) },
    { ...validArguments, evidence: [{ ...validArguments.evidence[0], start_line: 0 }] },
    { ...validArguments, evidence: [{ ...validArguments.evidence[0], why: "two\nlines" }] },
  ];
  for (const [index, invalid] of invalidCases.entries()) {
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

test("isolated packet contains only explicit request, latest summary, and retained reads", () => {
  const messages: AgentMessage[] = [
    { role: "compactionSummary", summary: "old summary", tokensBefore: 100, timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "raw history must not return" }], api: "anthropic-messages", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
    { role: "compactionSummary", summary: "latest summary", tokensBefore: 200, timestamp: 3 },
  ];
  const packet = buildFinalizationPacket(baseRequest(), [observedRead], latestCompactionSummary(messages));
  const parsed = JSON.parse(packet) as Record<string, unknown>;
  assert.equal(parsed.workingSummary, "latest summary");
  assert.deepEqual(parsed.repositoryObservations, [observedRead]);
  assert.equal(packet.includes("raw history must not return"), false);
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
