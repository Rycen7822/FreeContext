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
  if (JSON.stringify(tools.tools[0]?.inputSchema.required) !== JSON.stringify(["intent", "output"])) {
    throw new Error("MCP smoke did not expose the intent/output contract");
  }
  const invalid = await client.callTool({ name: "gather_context", arguments: { intent: "", output: "" } });
  const text = Array.isArray(invalid.content) ? invalid.content[0] : undefined;
  if (!text || typeof text !== "object" || text.type !== "text" || typeof text.text !== "string" || !text.text.includes("Input validation error")) {
    throw new Error("MCP smoke did not return the invalid-request text");
  }
  if (!invalid.isError) throw new Error("MCP smoke did not mark invalid input as an error");
  if (stderr.length > 0) throw new Error(`MCP server wrote to stderr: ${Buffer.concat(stderr).toString("utf8")}`);
  process.stdout.write(`${JSON.stringify({ status: "ok", tools: names })}\n`);
} finally {
  await client.close();
}
