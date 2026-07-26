import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productionRoots = [path.join(root, "src"), path.join(root, "bin")];
const files = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute);
    else if (entry.isFile() && absolute.endsWith(".mjs")) files.push(absolute);
  }
}

for (const directory of productionRoots) await walk(directory);

const forbidden = [
  [/(?:createWriteStream|writeFile(?:Sync)?|appendFile(?:Sync)?|truncate(?:Sync)?|rename(?:Sync)?|unlink(?:Sync)?|rm(?:Sync)?|rmdir(?:Sync)?|mkdir(?:Sync)?|copyFile(?:Sync)?|symlink(?:Sync)?|link(?:Sync)?|chmod(?:Sync)?|chown(?:Sync)?)\s*\(/u, "filesystem mutation API"],
  [/\bexec(?:File)?(?:Sync)?\s*\(/u, "arbitrary command execution API"],
  [/shell\s*:\s*true/u, "shell:true"],
  [/name\s*:\s*["'](?:bash|shell|write|edit|patch|git)["']/u, "forbidden model tool"],
];

const failures = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const [pattern, label] of forbidden) {
    if (pattern.test(source)) failures.push(`${path.relative(root, file)}: ${label}`);
  }
  const relative = path.relative(root, file);
  if (relative !== path.join("src", "tools", "process.mjs") && /node:child_process|\bspawn\s*\(/u.test(source)) {
    failures.push(`${relative}: child process use outside audited process wrapper`);
  }
}

const processWrapper = await readFile(path.join(root, "src", "tools", "process.mjs"), "utf8");
for (const required of ["shell: false", 'stdio: ["ignore", "pipe", "pipe"]']) {
  if (!processWrapper.includes(required)) failures.push(`src/tools/process.mjs: missing ${required}`);
}

const toolIndex = await readFile(path.join(root, "src", "tools", "index.mjs"), "utf8");
for (const expected of ["createReadTool", "createRgTool", "createGlobTool"]) {
  if (!toolIndex.includes(expected)) failures.push(`src/tools/index.mjs: missing ${expected}`);
}

if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`static check passed (${files.length} production modules)\n`);
}
