import { readFile, readdir } from "node:fs/promises";
import type { FreeContextRequest } from "./mcp/contracts.js";
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

function renderKnownReference(reference: FreeContextRequest["knownRefs"][number]): string {
  if (reference.kind === "stack") return `- [stack] ${reference.path}:${reference.line}`;
  if (reference.kind === "path") return `- [path] ${reference.path}`;
  return `- [symbol] ${reference.symbol}${reference.path ? ` in ${reference.path}` : ""}`;
}

export function buildUserPrompt(request: Readonly<FreeContextRequest>): string {
  return [
    "Repository exploration task (preserve all API, compatibility, test, error-handling, and boundary constraints):",
    "<task>",
    request.taskText,
    "</task>",
    "Known references:",
    ...(request.knownRefs.length > 0 ? request.knownRefs.map(renderKnownReference) : ["-"]),
    "Evidence questions:",
    ...request.evidenceQuestions.map((question) => (
      `- [${question.role}][${question.id}][${question.required ? "required" : "optional"}] ${question.question}`
    )),
    "Locate and verify evidence for these exact question IDs and roles. Submit verified evidence with submit_evidence when coverage is complete or the best supported partial result is known.",
  ].join("\n");
}
