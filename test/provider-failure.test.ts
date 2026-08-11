import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyProviderFailure,
  providerStatusCode,
} from "../src/runtime/provider-failure.js";

test("providerStatusCode reads bounded structured fields before standalone HTTP text", () => {
  assert.equal(providerStatusCode({ status: 429 }), 429);
  assert.equal(providerStatusCode({ response: { statusCode: 503 } }), 503);
  assert.equal(providerStatusCode({ cause: { cause: { status: 502 } } }), 502);
  assert.equal(providerStatusCode(new Error('503: {"type":"server_error"}')), 503);
  assert.equal(providerStatusCode("request rejected with HTTP 422"), 422);
  assert.equal(providerStatusCode({ cause: { cause: { cause: { status: 504 } } } }), undefined);
  assert.equal(providerStatusCode("completed in 5032 ms"), undefined);
});

test("provider failure classification preserves HTTP and timeout precedence", () => {
  assert.equal(classifyProviderFailure({ status: 429 }), "rate_limit");
  assert.equal(classifyProviderFailure(new Error("HTTP 503 service unavailable")), "server_error");
  assert.equal(classifyProviderFailure(new Error("network timeout")), "timeout");
  assert.equal(classifyProviderFailure(new Error("unrelated provider rejection")), "other");
});

test("provider failure classification recognizes statusless connection signatures", () => {
  for (const message of [
    "Connection error.",
    "fetch failed",
    "network error",
    "connect ECONNREFUSED 127.0.0.1:1",
    "read ECONNRESET",
    "request ECONNABORTED",
    "getaddrinfo ENOTFOUND provider.invalid",
    "getaddrinfo EAI_AGAIN provider.invalid",
    "UND_ERR_CONNECT_TIMEOUT",
    "socket hang up",
  ]) {
    assert.equal(classifyProviderFailure(new Error(message)), "connection", message);
  }
});
