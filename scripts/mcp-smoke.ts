import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "freecontext-mcp-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["bin/freecontext-mcp.mjs"],
  cwd: process.cwd(),
  stderr: "pipe",
});
const stderr: Buffer[] = [];
transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map(({ name }) => name);
  if (JSON.stringify(names) !== JSON.stringify(["gather_context"])) {
    throw new Error(`unexpected MCP tools: ${JSON.stringify(names)}`);
  }
  const terminal = await client.callTool({
    name: "gather_context",
    arguments: {
      taskText: "Verify the no-network terminal contract.",
      knownRefs: [],
      evidenceQuestions: [
        { id: "implementation", role: "implementation", question: "Where is the implementation?", required: true },
        { id: "tests", role: "test", question: "Where are the tests?", required: false },
      ],
    },
  });
  const structured = terminal.structuredContent as { status?: unknown; errorCode?: unknown } | undefined;
  if (structured?.status !== "failed" || structured.errorCode !== "INVALID_REQUEST") {
    throw new Error("MCP smoke did not return the expected host-identity terminal failure");
  }
  if (!Array.isArray(terminal.content) || terminal.content.length !== 1 || terminal.content[0]?.type !== "text") {
    throw new Error("MCP smoke did not return exactly one terminal text block");
  }
  if (stderr.length > 0) throw new Error(`MCP server wrote to stderr: ${Buffer.concat(stderr).toString("utf8")}`);
  process.stdout.write(`${JSON.stringify({ status: "ok", tools: names, terminalStatus: structured.status })}\n`);
} finally {
  await client.close();
}
