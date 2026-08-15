import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyProviderFailure,
  normalizeProviderFailure,
  providerStatusCode,
} from "../src/runtime/provider-failure.js";

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error("transport failed"), { code });
}

test("providerStatusCode reads bounded structured fields before standalone HTTP text", () => {
  assert.equal(providerStatusCode({ status: 429 }), 429);
  assert.equal(providerStatusCode({ response: { statusCode: 503 } }), 503);
  assert.equal(providerStatusCode({ cause: { cause: { status: 502 } } }), 502);
  assert.equal(providerStatusCode(new Error('503: {"type":"server_error"}')), 503);
  assert.equal(providerStatusCode("request rejected with HTTP 422"), 422);
  assert.equal(providerStatusCode({ cause: { cause: { cause: { status: 504 } } } }), 504);
  assert.equal(providerStatusCode({ cause: { cause: { cause: { cause: { status: 504 } } } } }), undefined);
  assert.equal(providerStatusCode("completed in 5032 ms"), undefined);
});

test("provider failure classification preserves HTTP and timeout precedence", () => {
  assert.equal(classifyProviderFailure({ status: 429 }), "rate_limit");
  assert.equal(classifyProviderFailure(new Error("HTTP 503 service unavailable")), "server_error");
  assert.equal(classifyProviderFailure(new Error('{"code":"SERVICE_BUSY","message":"服务繁忙，请稍后重试"}')), "server_error");
  assert.equal(classifyProviderFailure(codedError("ETIMEDOUT")), "timeout");
  assert.equal(classifyProviderFailure(new Error("unrelated provider rejection")), "other");
});

test("provider failure classification recognizes only structured transport codes", () => {
  for (const code of [
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "EAI_AGAIN",
    "UND_ERR_SOCKET",
  ]) {
    assert.equal(classifyProviderFailure(codedError(code)), "connection", code);
  }
  assert.equal(classifyProviderFailure(new Error("fetch failed")), "other");
});

test("normalizeProviderFailure emits a stable retry signal without raw provider text", () => {
  assert.deepEqual(normalizeProviderFailure({ response: { status: 503 }, code: "SERVICE_BUSY" }), {
    category: "server_error",
    retryable: true,
    source: "http",
    reason: "retryable_http_status",
    statusCode: 503,
    code: "SERVICE_BUSY",
    type: null,
  });
  assert.deepEqual(normalizeProviderFailure({ status: 429 }), {
    category: "rate_limit",
    retryable: true,
    source: "http",
    reason: "retryable_http_status",
    statusCode: 429,
    code: null,
    type: null,
  });
  assert.equal("message" in normalizeProviderFailure(new Error("secret response body")), false);
  assert.equal(normalizeProviderFailure({ code: "secret-response-fragment" }).code, null);
});

test("fatal structured metadata wins over retry fallbacks", () => {
  const auth = normalizeProviderFailure(
    { response: { status: 401 }, code: "INVALID_API_KEY", retryable: true },
    { piRetryable: true },
  );
  assert.equal(auth.retryable, false);
  assert.equal(auth.reason, "fatal_http_status");
  assert.equal(normalizeProviderFailure({ code: "QUOTA_EXCEEDED" }, { piRetryable: true }).retryable, false);
});

test("TokenRhythm plain-text compatibility is exact and provider-scoped", () => {
  const message = "模型服务暂时不可用，请稍后重试";
  assert.equal(normalizeProviderFailure(message, { baseUrl: "https://tokenrhythm.studio/v1" }).reason, "tokenrhythm_unavailable");
  assert.equal(normalizeProviderFailure(message, { baseUrl: "https://example.com/v1" }).retryable, false);
  assert.equal(normalizeProviderFailure(`prefix ${message}`, { provider: "tokenrhythm" }).retryable, false);
});
