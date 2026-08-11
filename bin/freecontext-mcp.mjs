#!/usr/bin/env node
import { runMcpServer } from "../dist/mcp/server.js";

await runMcpServer().catch((error) => {
  process.stderr.write(`freecontext-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
