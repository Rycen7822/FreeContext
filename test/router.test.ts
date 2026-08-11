import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ResolvedRouteConfig } from "../src/config.js";
import { ProviderError } from "../src/errors.js";
import type { PiBindings } from "../src/runtime/pi-bindings.js";
import { runPrimaryRoute } from "../src/runtime/router.js";
import { createWorkspace } from "../src/tools/workspace.js";
import { assistantText, baseConfig, baseRouteConfig, fakeBindings } from "./helpers.js";

function routeConfig(fallbackOn: ResolvedRouteConfig["fallbackOn"] = [
  "timeout",
  "rate_limit",
  "server_error",
  "connection",
]): ResolvedRouteConfig {
  return baseRouteConfig([
    baseConfig({ target: "primary", provider: "primary-provider" }),
    baseConfig({ target: "backup", provider: "backup-provider", model: "backup-model" }),
  ], { fallbackOn });
}

async function runRoute(
  root: string,
  bindings: PiBindings,
  route: ResolvedRouteConfig = routeConfig(),
  signal?: AbortSignal,
) {
  const workspace = await createWorkspace(root);
  return await runPrimaryRoute({
    cli: {},
    workspace,
    promptText: "inspect",
    startedAt: performance.now(),
    ...(signal ? { signal } : {}),
    dependencies: {
      routeConfig: route,
      bindings,
      repositoryTools: {
        tools: [],
        names: [],
        executables: { rg: null, jq: null, bat: null },
      },
      systemPrompt: "system",
    },
  });
}

test("route falls back in order for configured provider failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-route-"));
  try {
    const cases: ReadonlyArray<readonly [ResolvedRouteConfig["fallbackOn"][number], () => Error]> = [
      ["timeout", () => new Error("request timed out")],
      ["rate_limit", () => Object.assign(new Error("rate limited"), { status: 429 })],
      ["server_error", () => Object.assign(new Error("service unavailable"), { statusCode: 503 })],
      ["connection", () => new Error("Connection error.")],
    ];
    for (const [category, createError] of cases) {
      let calls = 0;
      const success = assistantText("done");
      const bindings = fakeBindings(async (prompts, _context, _config, emit) => {
        calls += 1;
        if (calls === 1) throw createError();
        await emit({ type: "turn_start" });
        await emit({ type: "turn_end", message: success, toolResults: [] });
        return [...prompts, success];
      });

      const result = await runRoute(root, bindings, routeConfig([category]));
      assert.equal(result.config.target, "backup", category);
      assert.equal(result.routeAttempts, 2, category);
      assert.equal(result.fallbacks, 1, category);
      assert.equal(calls, 2, category);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("route does not fall back for excluded, non-retryable, or aborted failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-route-"));
  try {
    const cases: Array<readonly [string, Error, ResolvedRouteConfig, AbortSignal?]> = [
      ["excluded", Object.assign(new Error("rate limited"), { status: 429 }), routeConfig(["timeout"])],
      ["non-retryable", Object.assign(new Error("unauthorized"), { status: 401 }), routeConfig()],
    ];
    const aborted = new AbortController();
    aborted.abort();
    cases.push(["aborted", new Error("request timed out"), routeConfig(), aborted.signal]);

    for (const [label, failure, route, signal] of cases) {
      let calls = 0;
      const bindings = fakeBindings(async () => {
        calls += 1;
        throw failure;
      });
      await assert.rejects(
        runRoute(root, bindings, route, signal),
        (error: unknown) => error instanceof ProviderError,
        label,
      );
      assert.equal(calls, 1, label);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("route never falls back after a tool call is accepted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-route-"));
  try {
    let calls = 0;
    const assistant = assistantText("tool call");
    const bindings = fakeBindings(async (_prompts, context, loopConfig) => {
      calls += 1;
      const decision = await loopConfig.beforeToolCall?.({
        assistantMessage: assistant,
        toolCall: { type: "toolCall", id: "route-tool", name: "read", arguments: {} },
        args: {},
        context,
      });
      assert.equal(decision, undefined);
      throw Object.assign(new Error("service unavailable"), { status: 503 });
    });

    await assert.rejects(
      runRoute(root, bindings),
      (error: unknown) => error instanceof ProviderError && !error.safeToFallback,
    );
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
