import test from "node:test";
import assert from "node:assert/strict";
import { retryProviderMessage, type ProviderAttempt } from "../src/runtime/provider-retry.js";
import { normalizeProviderFailure } from "../src/runtime/provider-failure.js";
import { assistantText } from "./helpers.js";

function failed(errorMessage: string | object): ProviderAttempt {
  const wireText = typeof errorMessage === "string" ? errorMessage : JSON.stringify(errorMessage);
  const message = assistantText("", { stopReason: "error", errorMessage: wireText });
  return { message, failure: normalizeProviderFailure(errorMessage) };
}

const noSleep = async (): Promise<boolean> => true;

test("provider retry recovers using the confirmed vector and deterministic jitter injection", async () => {
  const busy = failed({ code: "SERVICE_BUSY", message: "服务繁忙，请稍后重试" });
  const success: ProviderAttempt = { message: assistantText("ok"), failure: null };
  const scheduled: Array<[number, number]> = [];
  let calls = 0;

  const result = await retryProviderMessage(
    busy,
    async () => {
      calls += 1;
      return success;
    },
    { delaysMs: [3000, 6000, 12000], random: () => 0.5, sleep: noSleep },
    undefined,
    { onRetryScheduled: ({ baseDelayMs, delayMs }) => { scheduled.push([baseDelayMs, delayMs]); } },
  );

  assert.equal(result, success);
  assert.equal(calls, 1);
  assert.deepEqual(scheduled, [[3000, 3000]]);
});

test("provider retry exhausts exactly three attempts and never retries a fatal signal", async () => {
  const busy = failed({ code: "SERVICE_BUSY" });
  let calls = 0;
  const attempts: Array<[number, boolean]> = [];
  const exhausted = await retryProviderMessage(
    busy,
    async () => {
      calls += 1;
      return busy;
    },
    { delaysMs: [3000, 6000, 12000], random: () => 0.5, sleep: noSleep },
    undefined,
    { onFailure: ({ attempt, willRetry }) => { attempts.push([attempt, willRetry]); } },
  );
  assert.equal(exhausted, busy);
  assert.equal(calls, 3);
  assert.deepEqual(attempts, [[1, true], [2, true], [3, true], [4, false]]);

  const invalid = failed({ status: 401, code: "INVALID_API_KEY" });
  calls = 0;
  assert.equal(await retryProviderMessage(invalid, async () => {
    calls += 1;
    return busy;
  }, { delaysMs: [3000, 6000, 12000], sleep: noSleep }), invalid);
  assert.equal(calls, 0);
});

test("provider retry aborts an in-flight backoff without starting another request", async () => {
  const busy = failed({ status: 503 });
  const controller = new AbortController();
  let calls = 0;
  const pending = retryProviderMessage(
    busy,
    async () => {
      calls += 1;
      return busy;
    },
    {
      delaysMs: [3000, 6000, 12000],
      sleep: async (_delayMs, signal) => {
        controller.abort();
        return !signal?.aborted;
      },
    },
    controller.signal,
  );
  const result = await pending;
  assert.equal(result.message.stopReason, "aborted");
  assert.equal(result.failure, null);
  assert.equal(calls, 0);
});

test("jitter remains inside the fixed plus-or-minus twenty percent bound", async () => {
  const busy = failed({ status: 503 });
  const delays: number[] = [];
  for (const random of [() => 0, () => 1]) {
    await retryProviderMessage(
      busy,
      async () => ({ message: assistantText("ok"), failure: null }),
      { delaysMs: [3000], random, sleep: noSleep },
      undefined,
      { onRetryScheduled: ({ delayMs }) => { delays.push(delayMs); } },
    );
  }
  assert.deepEqual(delays, [2400, 3600]);
});
