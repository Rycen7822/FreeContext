import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createFreeContextMcpServer,
  createSingleFlightExecutor,
  parseMcpServerArgs,
} from "../src/mcp/server.js";
import {
  FREECONTEXT_ELIGIBILITY_POLICY,
  FreeContextResultSchema,
  SERVER_INSTRUCTIONS,
  TOOL_DESCRIPTION,
} from "../src/mcp/contracts.js";
import type { FreeContextRequest, FreeContextResult } from "../src/mcp/contracts.js";
import type { ContextTokenCounter } from "../src/runtime/context-budget.js";
import type { RunExplorerOptions } from "../src/runtime/run.js";

const tokenCounter: ContextTokenCounter = {
  countBatch: async (texts) => texts.map(() => 0),
};

function request(taskText: string): FreeContextRequest {
  return {
    taskText,
    knownRefs: [],
    evidenceQuestions: [
      { id: "impl", role: "implementation", question: "Where is it implemented?", required: true },
      { id: "tests", role: "test", question: "How is it tested?", required: false },
    ],
  };
}

function result(options: RunExplorerOptions): Readonly<FreeContextResult> {
  return FreeContextResultSchema.parse({
    status: "ready",
    summary: "Server result.",
    evidence: [{
      role: "implementation",
      path: "document.md",
      startLine: 1,
      endLine: 1,
      focusLine: 1,
      questionId: "impl",
      why: "Supports the result.",
    }],
    gaps: [{ questionId: "tests", reason: "No test was found." }],
    nextAction: {
      kind: "read",
      path: "document.md",
      startLine: 1,
      endLine: 1,
      reason: "Read the first evidence span.",
    },
    errorCode: null,
    sessionId: options.invocation.sessionId,
    sessionFile: options.invocation.sessionFile,
  });
}

test("no-network MCP loopback awaits one terminal Promise and never emits an intermediate result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-mcp-server-"));
  const workspace = path.join(root, "workspace");
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
    const explore = async (options: RunExplorerOptions): Promise<Readonly<FreeContextResult>> => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      assert.equal(options.dependencies?.tokenCounter, tokenCounter);
      if (calls === 1) {
        markFirstStarted?.();
        await firstRelease;
      }
      active -= 1;
      return result(options);
    };
    const runtime = createFreeContextMcpServer(
      { sessionDirectory: sessions },
      {
        tokenCounter,
        closeTokenCounter: () => { closeCalls += 1; },
        runExplorer: explore,
        invocationContextProvider: (metadata) => {
          const extra = metadata as { requestId: string | number };
          return ({
          invocationId: `invocation-${extra.requestId}`,
          callId: String(extra.requestId),
          workspaceRoot: workspace,
          workspaceRevision: "revision-1",
          });
        },
      },
    );
    await runtime.server.connect(serverTransport);
    await client.connect(clientTransport);

    assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
    assert.ok(client.getInstructions()?.includes(FREECONTEXT_ELIGIBILITY_POLICY.id));
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
    assert.deepEqual(tool?.inputSchema.required, ["taskText", "evidenceQuestions", "knownRefs"]);
    assert.ok(tool?.outputSchema?.properties?.status);

    let firstSettled = false;
    const first = client.callTool({ name: "gather_context", arguments: request("first") })
      .finally(() => { firstSettled = true; });
    await firstStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(firstSettled, false);
    const second = client.callTool({ name: "gather_context", arguments: request("second") });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    releaseFirst?.();
    const responses = await Promise.all([first, second]);
    assert.equal(calls, 2);
    assert.equal(maximumActive, 1);
    assert.ok(responses.every(
      (response) => (response.structuredContent as { status?: unknown } | undefined)?.status === "ready",
    ));
    assert.ok(responses.every(
      (response) => Array.isArray(response.content) && response.content.length === 1,
    ));

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

test("default MCP binding succeeds from public request identity and one file root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-mcp-server-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(root, "sessions");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "freecontext-public-binding", version: "1.0.0" },
    { capabilities: { roots: {} } },
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(workspace).href, name: "workspace" }],
  }));
  const invocations: RunExplorerOptions["invocation"][] = [];
  const runtime = createFreeContextMcpServer(
    { sessionDirectory: sessions },
    {
      tokenCounter,
      runExplorer: async (options) => { invocations.push(options.invocation); return result(options); },
    },
  );
  try {
    await mkdir(workspace);
    await runtime.server.connect(serverTransport);
    await client.connect(clientTransport);
    const first = FreeContextResultSchema.parse((await client.callTool({
      name: "gather_context",
      arguments: request("same request"),
    })).structuredContent);
    const second = FreeContextResultSchema.parse((await client.callTool({
      name: "gather_context",
      arguments: request("same request"),
    })).structuredContent);
    assert.equal(first.status, "ready");
    assert.equal(second.status, "ready");
    assert.equal(invocations.length, 2);
    assert.equal(invocations[0]?.workspaceRoot, workspace);
    assert.equal(invocations[0]?.workspaceRevision, "unversioned");
    assert.notEqual(invocations[0]?.invocationId, invocations[1]?.invocationId);
    assert.notEqual(invocations[0]?.callId, invocations[1]?.callId);
    assert.notEqual(first.sessionFile, second.sessionFile);
  } finally {
    await client.close().catch(() => undefined);
    await runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("default MCP binding rejects missing, multiple, and non-file roots before exploration", async () => {
  const fixtures = [
    { name: "missing", roots: [] },
    { name: "multiple", roots: [{ uri: "file:///one" }, { uri: "file:///two" }] },
    { name: "non-file", roots: [{ uri: "https://example.invalid/workspace" }] },
  ] as const;
  for (const fixture of fixtures) {
    const root = await mkdtemp(path.join(os.tmpdir(), `freecontext-mcp-${fixture.name}-`));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: `freecontext-${fixture.name}`, version: "1.0.0" },
      { capabilities: { roots: {} } },
    );
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [...fixture.roots] }));
    let explorerCalls = 0;
    const runtime = createFreeContextMcpServer(
      { sessionDirectory: path.join(root, "sessions") },
      {
        tokenCounter,
        runExplorer: async (options) => { explorerCalls += 1; return result(options); },
      },
    );
    try {
      await runtime.server.connect(serverTransport);
      await client.connect(clientTransport);
      const response = await client.callTool({ name: "gather_context", arguments: request(fixture.name) });
      const output = FreeContextResultSchema.parse(response.structuredContent);
      assert.equal(output.status, "failed");
      assert.equal(output.errorCode, "INVALID_REQUEST");
      assert.equal(output.sessionFile, null);
      assert.equal(explorerCalls, 0);
    } finally {
      await client.close().catch(() => undefined);
      await runtime.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }
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
