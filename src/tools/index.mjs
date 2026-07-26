import { ConfigurationError } from "../errors.mjs";
import { findExecutable } from "./process.mjs";
import { Semaphore } from "./semaphore.mjs";
import { createReadTool } from "./read.mjs";
import { createRgTool } from "./rg.mjs";
import { createGlobTool } from "./glob.mjs";
import { createJqTool } from "./jq.mjs";
import { createBatTool } from "./bat.mjs";

export async function detectToolExecutables() {
  const [rg, jq, bat] = await Promise.all([
    findExecutable("rg"),
    findExecutable("jq"),
    findExecutable(["bat", "batcat"]),
  ]);
  return Object.freeze({ rg, jq, bat });
}

export async function createRepositoryTools({ Type, workspace, config, executables = null }) {
  const resolved = executables || (await detectToolExecutables());
  if (!resolved.rg) {
    throw new ConfigurationError("ripgrep (rg) is required but was not found on PATH.");
  }
  const semaphore = new Semaphore(config.maxParallelTools);
  const common = { Type, workspace, semaphore, config };
  const tools = [
    createReadTool(common),
    createRgTool({ ...common, executable: resolved.rg }),
    createGlobTool({ ...common, executable: resolved.rg }),
  ];
  if (resolved.jq) tools.push(createJqTool({ ...common, executable: resolved.jq }));
  if (resolved.bat) tools.push(createBatTool({ ...common, executable: resolved.bat }));
  return Object.freeze({ tools, executables: resolved, names: tools.map((tool) => tool.name) });
}
