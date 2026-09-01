import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFreeContextMcpServer } from "../src/mcp/server.js";

test("MCP registers one minimal tool and rejects invalid requests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-mcp-surface-"));
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot);
  const runtime = createFreeContextMcpServer({ sessionDirectory: path.join(root, "sessions"), workspaceRoot }, {
    tokenCounter: { countBatch: async (texts) => texts.map((text) => text.length) },
    runExplorer: async ({ invocation }) => ({
      status: "complete",
      text: "unused",
      errorCode: null,
      sessionId: invocation.sessionId,
      sessionFile: invocation.sessionFile,
    }),
  });
  const client = new Client({ name: "minimal-contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), runtime.server.connect(serverTransport)]);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ["gather_context"]);
    const invalid = await client.callTool({ name: "gather_context", arguments: { question: "" } });
    assert.equal(invalid.isError, true);
    const block = Array.isArray(invalid.content) ? invalid.content[0] : undefined;
    assert.equal(block?.type, "text");
    if (block?.type === "text") assert.match(block.text, /Input validation error/u);
  } finally {
    await client.close().catch(() => undefined);
    await runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
