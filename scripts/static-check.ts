import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productionRoots = [path.join(root, "src"), path.join(root, "bin")];
const files: string[] = [];
const fullCodingAgentPackage = ["@earendil-works/pi", "coding-agent"].join("-");

async function walk(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute);
    else if (entry.isFile() && (absolute.endsWith(".ts") || absolute.endsWith(".mjs"))) files.push(absolute);
  }
}

for (const directory of productionRoots) await walk(directory);

const forbidden: readonly (readonly [RegExp, string])[] = [
  [/(?:createWriteStream|writeFile(?:Sync)?|appendFile(?:Sync)?|truncate(?:Sync)?|rename(?:Sync)?|unlink(?:Sync)?|rm(?:Sync)?|rmdir(?:Sync)?|mkdir(?:Sync)?|copyFile(?:Sync)?|symlink(?:Sync)?|link(?:Sync)?|chmod(?:Sync)?|chown(?:Sync)?)\s*\(/u, "filesystem mutation API"],
  [/\bexec(?:File)?(?:Sync)?\s*\(/u, "arbitrary command execution API"],
  [/shell\s*:\s*true/u, "shell:true"],
  [/name\s*:\s*["'](?:bash|shell|write|edit|patch|git)["']/u, "forbidden model tool"],
  [new RegExp(fullCodingAgentPackage, "u"), "full pi-coding-agent dependency"],
  [/\.jsonl\b/u, "persistent transcript path"],
  [/(?:session-tree|session-manager|transcript-store|transcript-writer|persistence-store)/u, "session persistence module"],
];

const failures: string[] = [];
const hostPersistenceModules = new Set([
  path.join("src", "benchmark", "master-context.ts"),
  path.join("src", "session", "store.ts"),
]);
for (const file of files) {
  const source = await readFile(file, "utf8");
  const relative = path.relative(root, file);
  for (const [pattern, label] of forbidden) {
    if (
      hostPersistenceModules.has(relative) &&
      (label === "filesystem mutation API" || label === "persistent transcript path")
    ) {
      continue;
    }
    if (pattern.test(source)) failures.push(`${path.relative(root, file)}: ${label}`);
  }
  if (relative !== path.join("src", "tools", "process.ts") && /node:child_process|\bspawn\s*\(/u.test(source)) {
    failures.push(`${relative}: child process use outside audited process wrapper`);
  }
  if (
    relative === path.join("src", "runtime", "context-compaction.ts") &&
    /node:fs|node:child_process|writeFile|createWriteStream/u.test(source)
  ) {
    failures.push(`${relative}: compaction must remain in-memory and process-free`);
  }
}

const packageSource = await readFile(path.join(root, "package.json"), "utf8");
if (packageSource.includes(fullCodingAgentPackage)) {
  failures.push("package.json: full pi-coding-agent dependency");
}

const pluginManifest = JSON.parse(await readFile(path.join(root, ".codex-plugin", "plugin.json"), "utf8")) as {
  mcpServers?: unknown;
  skills?: unknown;
};
if (pluginManifest.mcpServers !== "./.mcp.json" || pluginManifest.skills !== "./skills/") {
  failures.push("plugin.json: expected bundled MCP plus shadow skill paths");
}
const bundledMcp = JSON.parse(await readFile(path.join(root, ".mcp.json"), "utf8")) as Record<string, unknown>;
const expectedBundledMcp = {
  freecontext: {
    command: "node",
    args: ["bin/freecontext-mcp.mjs"],
    cwd: ".",
    startup_timeout_sec: 30,
    tool_timeout_sec: 1_800,
    required: false,
  },
};
if (JSON.stringify(bundledMcp) !== JSON.stringify(expectedBundledMcp)) {
  failures.push(".mcp.json: expected the exact direct freecontext stdio server map");
}

const mcpServer = await readFile(path.join(root, "src", "mcp", "server.ts"), "utf8");
const registeredTools = [...mcpServer.matchAll(/registerTool\(\s*["']([^"']+)["']/gu)]
  .map((match) => match[1]);
if (JSON.stringify(registeredTools) !== JSON.stringify(["gather_context"])) {
  failures.push(`src/mcp/server.ts: unexpected registered tools ${JSON.stringify(registeredTools)}`);
}
for (const required of [
  "readOnlyHint: true",
  "destructiveHint: false",
  "openWorldHint: true",
  "inputSchema: GatherContextInputSchema",
  "outputSchema: GatherContextOutputSchema",
]) {
  if (!mcpServer.includes(required)) failures.push(`src/mcp/server.ts: missing ${required}`);
}
if ((mcpServer.match(/new McpServer\(/gu) ?? []).length !== 1) {
  failures.push("src/mcp/server.ts: expected exactly one MCP server");
}

const mcpEntries = await Promise.all(
  files
    .filter((file) => path.relative(root, file).startsWith(`${path.join("src", "mcp")}${path.sep}`))
    .map(async (file) => ({ file, source: await readFile(file, "utf8") })),
);
if (mcpEntries.some(({ source }) => /\bexplore_repository\b/u.test(source))) {
  failures.push("src/mcp: legacy proposed tool alias remains");
}
if (mcpEntries.some(({ source }) => /runPiSession|runPrimaryRoute/u.test(source))) {
  failures.push("src/mcp: duplicated explorer runtime");
}
if (mcpEntries.some(({ file, source }) => (
  path.relative(root, file) !== path.join("src", "mcp", "server.ts") &&
  /\bMcpServer\b|StdioServerTransport/u.test(source)
))) {
  failures.push("src/mcp: transport owner escaped server.ts");
}

const processWrapper = await readFile(path.join(root, "src", "tools", "process.ts"), "utf8");
for (const required of ["shell: false", 'stdio: ["ignore", "pipe", "pipe"]']) {
  if (!processWrapper.includes(required)) failures.push(`src/tools/process.ts: missing ${required}`);
}

const toolIndex = await readFile(path.join(root, "src", "tools", "index.ts"), "utf8");
for (const expected of ["createReadTool", "createRgTool", "createGlobTool"]) {
  if (!toolIndex.includes(expected)) failures.push(`src/tools/index.ts: missing ${expected}`);
}

if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`static check passed (${files.length} production modules)\n`);
}
