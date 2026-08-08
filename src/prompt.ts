import { readFile, readdir } from "node:fs/promises";
import type { Workspace } from "./tools/contracts.js";

export async function buildWorkspaceOverview(
  workspace: Workspace,
  { maxEntries = 120 }: Readonly<{ maxEntries?: number }> = {},
): Promise<string> {
  const entries = await readdir(workspace.root, { withFileTypes: true });
  const visible = entries
    .filter((entry) => !workspace.isSensitiveRelativePath(entry.name))
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
      return left.name.localeCompare(right.name);
    })
    .slice(0, maxEntries)
    .map((entry) => `${entry.isDirectory() ? "[dir] " : "[file]"} ${entry.name}`);
  if (entries.length > visible.length) visible.push(`[truncated] ${entries.length - visible.length} additional top-level entries`);
  return visible.length ? visible.join("\n") : "[empty workspace]";
}

export async function loadSystemPrompt({
  promptPath,
  workspace,
  toolNames,
}: {
  readonly promptPath: string;
  readonly workspace: Workspace;
  readonly toolNames: readonly string[];
}): Promise<string> {
  const [template, overview] = await Promise.all([
    readFile(promptPath, "utf8"),
    buildWorkspaceOverview(workspace),
  ]);
  const replacements = {
    WORKSPACE: workspace.root,
    TOOLS: toolNames.map((name) => `\`${name}\``).join(", "),
    OVERVIEW: overview,
  };
  let rendered = template;
  for (const [name, value] of Object.entries(replacements)) {
    rendered = rendered.split(`{{${name}}}`).join(String(value));
  }
  return rendered.trim();
}

export function buildUserPrompt(query: string): string {
  return [
    "Repository exploration request:",
    "<request>",
    query.trim(),
    "</request>",
    "Locate and verify the repository evidence, then return only the required <final_answer> block.",
  ].join("\n");
}

export function buildRepairPrompt(validationProblems: readonly string[]): string {
  const details = validationProblems.length
    ? validationProblems.map((problem) => `- ${problem}`).join("\n")
    : "- The prior response did not follow the final response contract.";
  return [
    "Your previous final response failed validation:",
    details,
    "Using only evidence already present in the transcript, emit a corrected <final_answer> block now.",
    "Do not call tools. Do not add commentary outside the block. Use exact repository-relative path:line-line citations.",
  ].join("\n");
}
