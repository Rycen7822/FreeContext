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
const benchmarkPersistenceModules = new Set([
  path.join("src", "benchmark", "master-context.ts"),
  path.join("src", "benchmark", "session-file.ts"),
]);
for (const file of files) {
  const source = await readFile(file, "utf8");
  const relative = path.relative(root, file);
  for (const [pattern, label] of forbidden) {
    if (
      benchmarkPersistenceModules.has(relative) &&
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
