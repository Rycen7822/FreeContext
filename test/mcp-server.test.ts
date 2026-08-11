import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createFreeContextMcpServer,
  createSingleFlightExecutor,
  parseMcpServerArgs,
} from "../src/mcp/server.js";
import {
  INVOCATION_POLICY,
  SERVER_INSTRUCTIONS,
  TOOL_DESCRIPTION,
} from "../src/mcp/contracts.js";
import type { ContextTokenCounter } from "../src/runtime/context-budget.js";
import type { ExplorerResult, RunExplorerOptions } from "../src/runtime/run.js";
import type { ExplorerSessionCapture } from "../src/runtime/session-capture.js";

const tokenCounter: ContextTokenCounter = {
  countBatch: async (texts) => texts.map(() => 0),
};

function result(workspace: string): Readonly<ExplorerResult> {
  return {
    status: "completed",
    answer: "validated",
    summary: "Server result.",
    evidence: [{ path: "document.md", start: 1, end: 1, reason: "Supports the result." }],
    gaps: ["none"],
    validationProblems: [],
    metrics: {},
    runtime: { workspace },
  } as unknown as Readonly<ExplorerResult>;
}

function capture(workspace: string): Readonly<ExplorerSessionCapture> {
  return {
    schemaVersion: "freecontext-session-v1",
    request: "context",
    runtime: { workspace },
    primary: { output: "raw" },
    outcome: { status: "completed", answer: "validated" },
  } as unknown as Readonly<ExplorerSessionCapture>;
}

test("MCP server advertises one exact tool and serializes two concurrent calls", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-mcp-server-"));
  const workspace = path.join(root, "documents");
  const sessions = path.join(root, "sessions");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "freecontext-test", version: "1.0.0" });
  let releaseFirst: (() => void) | undefined;
  let markFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  let closeCalls = 0;
  try {
    await mkdir(workspace);
    const explore = async (options: RunExplorerOptions) => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      assert.equal(options.dependencies?.tokenCounter, tokenCounter);
      await options.onSessionCapture?.(capture(workspace));
      if (calls === 1) {
        markFirstStarted?.();
        await firstRelease;
      }
      active -= 1;
      return result(workspace);
    };
    const runtime = createFreeContextMcpServer(
      { sessionDirectory: sessions },
      {
        tokenCounter,
        closeTokenCounter: () => { closeCalls += 1; },
        runExplorer: explore,
      },
    );
    await runtime.server.connect(serverTransport);
    await client.connect(clientTransport);

    assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
    assert.ok(client.getInstructions()?.startsWith(INVOCATION_POLICY));
    assert.ok(SERVER_INSTRUCTIONS.length <= 512);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(({ name }) => name), ["gather_context"]);
    const tool = listed.tools[0];
    assert.equal(tool?.title, "Gather context with FreeContext");
    assert.equal(tool?.description, TOOL_DESCRIPTION);
    assert.deepEqual(tool?.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    assert.deepEqual(tool?.inputSchema.required, ["query", "workspace"]);
    assert.ok(tool?.outputSchema?.properties?.status);

    const first = client.callTool({
      name: "gather_context",
      arguments: { query: "first", workspace },
    });
    await firstStarted;
    const second = client.callTool({
      name: "gather_context",
      arguments: { query: "second", workspace },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    releaseFirst?.();
    const responses = await Promise.all([first, second]);
    assert.equal(calls, 2);
    assert.equal(maximumActive, 1);
    assert.ok(responses.every(
      (response) => (response.structuredContent as { status?: unknown } | undefined)?.status === "completed",
    ));
    assert.ok(responses.every((response) => (response.content as unknown[]).length === 1));

    await client.close();
    await runtime.close();
    assert.equal(closeCalls, 1);
  } finally {
    releaseFirst?.();
    await client.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("single-flight executor continues in FIFO order after a rejected task", async () => {
  const executor = createSingleFlightExecutor();
  const order: string[] = [];
  const first = executor.run(async () => {
    order.push("first");
    throw new Error("expected");
  });
  const second = executor.run(async () => { order.push("second"); return 2; });
  await assert.rejects(first, /expected/u);
  assert.equal(await second, 2);
  assert.deepEqual(order, ["first", "second"]);
});

test("MCP server arguments are strict and keep config/session controls host-owned", () => {
  assert.deepEqual(
    parseMcpServerArgs(["--config", "config.toml", "--session-dir", "sessions"], {}),
    {
      configFile: path.resolve("config.toml"),
      sessionDirectory: path.resolve("sessions"),
    },
  );
  assert.deepEqual(parseMcpServerArgs([], { XDG_STATE_HOME: "/state" }), {
    sessionDirectory: "/state/freecontext/sessions",
  });
  assert.throws(() => parseMcpServerArgs(["--unknown", "value"], {}), /Unknown/u);
  assert.throws(() => parseMcpServerArgs(["--config"], {}), /requires a value/u);
  assert.throws(() => parseMcpServerArgs(["--config", "a", "--config", "b"], {}), /Duplicate/u);
});
