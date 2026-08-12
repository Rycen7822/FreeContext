import test from "node:test";
import assert from "node:assert/strict";
import { retryProviderMessage, shouldRetryProviderMessage } from "../src/runtime/provider-retry.js";
import { assistantText } from "./helpers.js";

test("provider retry recognizes TokenRhythm busy responses and recovers with bounded backoff", async () => {
  const busy = assistantText("", {
    stopReason: "error",
    errorMessage: '{"code":"SERVICE_BUSY","message":"服务繁忙，请稍后重试"}',
  });
  const success = assistantText("ok");
  const scheduled: number[] = [];
  let calls = 0;

  assert.equal(shouldRetryProviderMessage(busy), true);
  const result = await retryProviderMessage(
    busy,
    async () => {
      calls += 1;
      return success;
    },
    { maxRetries: 3, baseDelayMs: 1 },
    undefined,
    { onRetryScheduled: (_message, _attempt, _maxRetries, delayMs) => { scheduled.push(delayMs); } },
  );

  assert.equal(result, success);
  assert.equal(calls, 1);
  assert.deepEqual(scheduled, [1]);
});

test("provider retry exhausts its budget and does not retry deterministic failures", async () => {
  const busy = assistantText("", { stopReason: "error", errorMessage: "SERVICE_BUSY" });
  let calls = 0;
  const exhausted = await retryProviderMessage(
    busy,
    async () => {
      calls += 1;
      return busy;
    },
    { maxRetries: 3, baseDelayMs: 1 },
  );
  assert.equal(exhausted, busy);
  assert.equal(calls, 3);

  const invalid = assistantText("", { stopReason: "error", errorMessage: "invalid API key" });
  calls = 0;
  assert.equal(await retryProviderMessage(invalid, async () => {
    calls += 1;
    return busy;
  }, { maxRetries: 3, baseDelayMs: 1 }), invalid);
  assert.equal(calls, 0);
});

test("provider retry aborts an in-flight backoff without starting another request", async () => {
  const busy = assistantText("", { stopReason: "error", errorMessage: "503 service unavailable" });
  const controller = new AbortController();
  let calls = 0;
  const pending = retryProviderMessage(
    busy,
    async () => {
      calls += 1;
      return busy;
    },
    { maxRetries: 3, baseDelayMs: 1000 },
    controller.signal,
  );
  controller.abort();
  const result = await pending;
  assert.equal(result.stopReason, "aborted");
  assert.equal(calls, 0);
});
