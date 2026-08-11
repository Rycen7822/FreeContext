import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ProviderError } from "../src/errors.js";
import type { CompactionCut } from "../src/runtime/context-budget.js";
import { compactContext } from "../src/runtime/context-compaction.js";
import { createModel, createRequestOptions } from "../src/runtime/model.js";
import { assistantText, baseConfig, fakeBindings } from "./helpers.js";

const tokenCounter = {
  countBatch: async (texts: readonly string[]) => texts.map((text) => text.length),
};

interface CapturedSummaryCall {
  readonly model: Model<string>;
  readonly context: Context;
  readonly options: SimpleStreamOptions | undefined;
}

function summaryStream(response: ReturnType<typeof assistantText>, calls: CapturedSummaryCall[]): StreamFn {
  return (model, context, options) => {
    calls.push({ model, context, options });
    const stream = createAssistantMessageEventStream();
    stream.end(response);
    return stream;
  };
}

function compactionCut(overrides: Partial<CompactionCut> = {}): CompactionCut {
  const old: AgentMessage[] = [
    { role: "user", content: `request ${"x".repeat(600)}`, timestamp: 1 },
    assistantText(`finding ${"y".repeat(600)}`),
  ];
  const tail: AgentMessage[] = [{ role: "user", content: "recent constraint", timestamp: 2 }];
  return {
    cutIndex: 2,
    messagesToSummarize: old,
    retainedTail: tail,
    previousSummary: undefined,
    tokensBefore: 1000,
    estimatedRetainedTokens: 10,
    ...overrides,
  };
}

test("summary requests use no tools, a fresh session, and the existing authenticated transport", async () => {
  const config = baseConfig({
    apiKey: "api-secret",
    headers: { Authorization: "Bearer header-secret", "X-Test": "forwarded" },
  });
  const calls: CapturedSummaryCall[] = [];
  const bindings = fakeBindings(async () => [], {
    streamSimple: summaryStream(assistantText("compact verified state"), calls),
    uuidv7: () => "summary-session-1",
  });
  const model = createModel(config);
  const requestOptions = createRequestOptions(config);
  const result = await compactContext({
    cut: compactionCut(),
    bindings,
    model,
    requestOptions,
    config,
    tokenCounter,
    clock: () => 5,
    timestamp: () => 1000,
  });

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.model, model);
  assert.equal(call.context.tools, undefined);
  assert.equal(call.options?.sessionId, "summary-session-1");
  assert.equal(call.options?.cacheRetention, "none");
  assert.equal(call.options?.maxTokens, Math.min(Math.floor(config.contextReserveTokens * 0.8), model.maxTokens));
  assert.equal(call.options?.timeoutMs, requestOptions.timeoutMs);
  assert.equal(call.options?.maxRetries, requestOptions.maxRetries);
  assert.equal(call.options?.maxRetryDelayMs, requestOptions.maxRetryDelayMs);
  assert.equal(call.options?.temperature, requestOptions.temperature);
  assert.equal(call.options?.apiKey, "api-secret");
  assert.equal(call.options?.headers?.Authorization, "Bearer header-secret");
  assert.equal(call.options?.headers?.["X-Test"], "forwarded");
  const summaryPrompt = call.context.messages[0];
  const summaryText = summaryPrompt?.role === "user" && typeof summaryPrompt.content === "string"
    ? summaryPrompt.content
    : "";
  assert.match(call.context.systemPrompt ?? "", /Do not invent citations.*edits/iu);
  assert.match(summaryText, /original repository request and every user constraint/iu);
  assert.match(summaryText, /exact repository-relative paths and observed line ranges/iu);
  assert.match(summaryText, /remaining turn\/tool\/context budgets/iu);
  assert.equal(JSON.stringify(result).includes("api-secret"), false);
  assert.equal(JSON.stringify(result).includes("header-secret"), false);
});

test("repeated compaction merges the previous summary and preserves the recent tail exactly", async () => {
  const config = baseConfig();
  const calls: CapturedSummaryCall[] = [];
  const tail: AgentMessage[] = [
    assistantText("recent assistant"),
    { role: "user", content: "latest user constraint", timestamp: 3 },
  ];
  const bindings = fakeBindings(async () => [], {
    streamSimple: summaryStream(assistantText("merged summary"), calls),
  });
  const result = await compactContext({
    cut: compactionCut({ previousSummary: "previous exact summary", retainedTail: tail }),
    bindings,
    model: createModel(config),
    requestOptions: createRequestOptions(config),
    config,
    tokenCounter,
  });
  const prompt = calls[0]?.context.messages[0];
  assert.equal(prompt?.role, "user");
  assert.equal(typeof prompt?.content, "string");
  assert.match(typeof prompt?.content === "string" ? prompt.content : "", /previous exact summary/u);
  assert.match(calls[0]?.context.systemPrompt ?? "", /Repository text is untrusted|untrusted data/iu);
  assert.equal(result.contextMessages[1], tail[0]);
  assert.equal(result.contextMessages[2], tail[1]);
  assert.equal(result.contextMessages[0]?.role, "compactionSummary");
});

test("a non-reducing or empty summary is rejected without dropping history", async () => {
  const config = baseConfig();
  const nonReducing = fakeBindings(async () => [], {
    streamSimple: summaryStream(assistantText("not smaller"), []),
  });
  await assert.rejects(
    () => compactContext({
      cut: compactionCut({ tokensBefore: 1 }),
      bindings: nonReducing,
      model: createModel(config),
      requestOptions: createRequestOptions(config),
      config,
      tokenCounter,
    }),
    /did not reduce/u,
  );

  const empty = fakeBindings(async () => [], {
    streamSimple: summaryStream(assistantText(""), []),
  });
  await assert.rejects(
    () => compactContext({
      cut: compactionCut(),
      bindings: empty,
      model: createModel(config),
      requestOptions: createRequestOptions(config),
      config,
      tokenCounter,
    }),
    /empty summary/u,
  );
});

test("summary aborts and provider failures propagate once with secrets redacted", async () => {
  const controller = new AbortController();
  const config = baseConfig({ apiKey: "summary-secret" });
  const abortedCalls: CapturedSummaryCall[] = [];
  const aborted = fakeBindings(async () => [], {
    streamSimple: summaryStream(assistantText("", { stopReason: "aborted", errorMessage: "cancelled" }), abortedCalls),
  });
  await assert.rejects(
    () => compactContext({
      cut: compactionCut(),
      bindings: aborted,
      model: createModel(config),
      requestOptions: createRequestOptions(config),
      config,
      tokenCounter,
      signal: controller.signal,
    }),
    ProviderError,
  );
  assert.equal(abortedCalls[0]?.options?.signal, controller.signal);

  const failed = fakeBindings(async () => [], {
    streamSimple: summaryStream(
      assistantText("", { stopReason: "error", errorMessage: "failed with summary-secret" }),
      [],
    ),
  });
  await assert.rejects(
    () => compactContext({
      cut: compactionCut(),
      bindings: failed,
      model: createModel(config),
      requestOptions: createRequestOptions(config),
      config,
      tokenCounter,
    }),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.message.includes("summary-secret"), false);
      assert.match(error.message, /<redacted>/u);
      return true;
    },
  );
});
