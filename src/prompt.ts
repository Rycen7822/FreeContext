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

function renderTarget(target: FreeContextRequest["evidenceQuestions"][number]["coverageTargets"][number]): string {
  const subject = target.subject.kind === "path"
    ? target.subject.path
    : target.subject.kind === "symbol"
      ? `${target.subject.symbol}${target.subject.path ? ` in ${target.subject.path}` : ""}`
      : target.subject.topic;
  return `${target.id}:${target.subject.kind}:${subject}:${target.factKind}:${target.coverageMode}`;
}

export function buildUserPrompt(request: Readonly<FreeContextRequest>): string {
  return [
    "Repository exploration task (preserve all API, compatibility, test, error-handling, and boundary constraints):",
    "<task>",
    request.taskText,
    "</task>",
    `Current work unit: [${request.workUnit.outcome}] ${request.workUnit.goal}`,
    "Known references:",
    ...(request.knownRefs.length > 0 ? request.knownRefs.map(renderKnownReference) : ["-"]),
    "Evidence questions:",
    ...request.evidenceQuestions.map((question) => (
      `- [${question.role}][${question.id}][${question.required ? "required" : "optional"}]${question.minimumSpans === undefined ? "" : `[minimum-spans=${question.minimumSpans}]`} [target=${question.coverageTargets.map(renderTarget).join(", ")}] ${question.question}`
    )),
    "Locate and verify each listed question independently. In submit_evidence, question_id must match a listed question; each canonical question has one target, which the harness derives, so do not send target_id. Cite an observed span with observation_id and start_line/end_line; the harness derives path and focus. Required slots use max(minimumSpans, declared target count) and total at most six; missing any required question keeps the result partial. Exhaustive caller relationships must list every discovered member, prove the observed enumeration boundary with coverage_basis=true, and include gaps for unresolved scope. Before submission keep each span brief and self-contained, normally 8–24 lines; use longer only when needed. Prefer decisive spans, submit a single-target answer immediately when one span suffices, and do not rely on post-hoc fitter trimming. Otherwise report the exact target gap.",
  ].join("\n");
}
