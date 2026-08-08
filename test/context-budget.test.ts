import test from "node:test";
import assert from "node:assert/strict";
import { shouldCompact } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { ContextBudgetError } from "../src/errors.js";
import type { ContextEstimators } from "../src/runtime/context-budget.js";
import {
  assertInitialRequestFits,
  estimateEffectiveContextTokens,
  estimateInitialRequestTokens,
  selectCompactionCut,
} from "../src/runtime/context-budget.js";
import { assistantText } from "./helpers.js";

const uniformEstimators: ContextEstimators = {
  estimateTokens: () => 10,
  estimateContextTokens: (messages) => ({ tokens: messages.length * 10 }),
};

const lengthEstimators: ContextEstimators = {
  estimateTokens: (message) => {
    if (message.role === "user" && typeof message.content === "string") return message.content.length;
    return 10;
  },
  estimateContextTokens: (messages) => ({ tokens: messages.length * 10 }),
};

const tool: AgentTool = {
  name: "read",
  label: "Read",
  description: "Read a file",
  parameters: Type.Object({ path: Type.String() }),
  execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

test("compaction threshold is deterministic below, at, and above the reserve boundary", () => {
  const settings = { enabled: true, reserveTokens: 20, keepRecentTokens: 30 };
  assert.equal(shouldCompact(79, 100, settings), false);
  assert.equal(shouldCompact(80, 100, settings), false);
  assert.equal(shouldCompact(81, 100, settings), true);
  assert.equal(shouldCompact(100, 100, { ...settings, enabled: false }), false);
});

test("initial admission accounts for system, prompt, messages, and tool schemas", () => {
  const messages: AgentMessage[] = [{ role: "user", content: "history", timestamp: 0 }];
  const snapshot = estimateInitialRequestTokens({
    systemPrompt: "system",
    promptText: "prompt",
    messages,
    tools: [tool],
    estimators: lengthEstimators,
    contextWindow: 1000,
    reserveTokens: 200,
  });
  assert.equal(snapshot.messageTokens, 10);
  assert.ok(snapshot.fixedTokens > "systemprompt".length);
  assert.equal(snapshot.totalTokens, snapshot.messageTokens + snapshot.fixedTokens);
  assert.equal(snapshot.availableTokens, 800);
});

test("an oversized initial request without compressible history is rejected before a provider call", () => {
  const snapshot = estimateInitialRequestTokens({
    systemPrompt: "s".repeat(100),
    promptText: "p".repeat(100),
    messages: [],
    tools: [],
    estimators: lengthEstimators,
    contextWindow: 200,
    reserveTokens: 50,
  });
  assert.throws(
    () => assertInitialRequestFits(snapshot, [], 20, lengthEstimators),
    ContextBudgetError,
  );
});

test("repeated compaction extracts the previous summary instead of serializing it again", () => {
  const previous = {
    role: "compactionSummary" as const,
    summary: "prior verified state",
    tokensBefore: 100,
    timestamp: 0,
  };
  const messages: AgentMessage[] = [
    previous,
    { role: "user", content: "older", timestamp: 1 },
    assistantText("middle"),
    { role: "user", content: "recent", timestamp: 2 },
  ];
  const cut = selectCompactionCut(messages, 15, uniformEstimators);
  assert.ok(cut);
  assert.equal(cut.previousSummary, "prior verified state");
  assert.deepEqual(cut.messagesToSummarize, [messages[1]]);
  assert.deepEqual(cut.retainedTail, [messages[2], messages[3]]);
  assert.equal(cut.messagesToSummarize.includes(previous), false);
});

test("cut selection keeps an assistant tool call and its following result together", () => {
  const assistant = assistantText("", {
    content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } }],
    stopReason: "toolUse",
  });
  const result = {
    role: "toolResult" as const,
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text" as const, text: "evidence" }],
    isError: false,
    timestamp: 2,
  };
  const messages: AgentMessage[] = [
    { role: "user", content: "old", timestamp: 0 },
    assistant,
    result,
    { role: "user", content: "recent", timestamp: 3 },
  ];
  const cut = selectCompactionCut(messages, 25, uniformEstimators);
  assert.ok(cut);
  assert.equal(cut.retainedTail[0], assistant);
  assert.equal(cut.retainedTail[1], result);
  assert.notEqual(cut.retainedTail[0]?.role, "toolResult");
});

test("a compaction summary invalidates stale provider usage retained on assistant messages", () => {
  const assistant = assistantText("recent", {
    usage: {
      input: 900,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 920,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const messages: AgentMessage[] = [
    { role: "compactionSummary", summary: "state", tokensBefore: 1000, timestamp: 0 },
    assistant,
  ];
  assert.equal(estimateEffectiveContextTokens(messages, uniformEstimators), 20);
});
