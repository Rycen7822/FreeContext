import type { AgentTool } from "@earendil-works/pi-agent-core";
import { ConfigurationError } from "../errors.js";
import { findExecutable } from "./process.js";
import { Semaphore } from "./semaphore.js";
import { createReadTool } from "./read.js";
import { createRgTool } from "./rg.js";
import { createGlobTool } from "./glob.js";
import { createJqTool } from "./jq.js";
import { createBatTool } from "./bat.js";
import type { RepositoryToolSet, ToolContext, ToolExecutables } from "./contracts.js";

export async function detectToolExecutables(): Promise<Readonly<ToolExecutables>> {
  const [rg, jq, bat] = await Promise.all([
    findExecutable("rg"),
    findExecutable("jq"),
    findExecutable(["bat", "batcat"]),
  ]);
  return Object.freeze({ rg, jq, bat });
}

export async function createRepositoryTools({
  Type,
  workspace,
  config,
  executables = null,
}: Pick<ToolContext, "Type" | "workspace" | "config"> & {
  readonly executables?: Readonly<ToolExecutables> | null;
}): Promise<Readonly<RepositoryToolSet>> {
  const resolved = executables || (await detectToolExecutables());
  if (!resolved.rg) {
    throw new ConfigurationError("ripgrep (rg) is required but was not found on PATH.");
  }
  const semaphore = new Semaphore(config.maxParallelTools);
  const common = { Type, workspace, semaphore, config };
  const tools: AgentTool[] = [
    createReadTool(common),
    createRgTool({ ...common, executable: resolved.rg }),
    createGlobTool({ ...common, executable: resolved.rg }),
  ];
  if (resolved.jq) tools.push(createJqTool({ ...common, executable: resolved.jq }));
  if (resolved.bat) tools.push(createBatTool({ ...common, executable: resolved.bat }));
  return Object.freeze({
    tools: Object.freeze(tools),
    executables: resolved,
    names: Object.freeze(tools.map((tool) => tool.name)),
  });
}
