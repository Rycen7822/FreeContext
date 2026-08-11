import { createReadStream } from "node:fs";
import readline from "node:readline";
import { assertDirectFileSize } from "../tools/workspace.js";
import type { Workspace } from "../tools/contracts.js";

const MAX_EVIDENCE_LINE = 10_000_000;

export interface EvidenceCitation {
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly reason: string;
}

export interface ParsedFinalBlock {
  readonly rawText: string;
  readonly block: string | null;
  readonly summary: string;
  readonly evidence: readonly EvidenceCitation[];
  readonly gaps: readonly string[];
  readonly problems: readonly string[];
}

export interface ValidatedEvidenceCitation extends EvidenceCitation {
  readonly totalLines: number;
}

interface ValidationFields extends Omit<ParsedFinalBlock, "evidence"> {
  readonly evidence: readonly ValidatedEvidenceCitation[];
}

export interface CompletedExplorerOutput extends ValidationFields {
  readonly valid: true;
  readonly status: "completed";
  readonly block: string;
}

export interface PartialExplorerOutput extends ValidationFields {
  readonly valid: true;
  readonly status: "partial";
  readonly block: string;
}

export interface InvalidExplorerOutput extends ValidationFields {
  readonly valid: false;
  readonly status: "invalid";
}

export type UsableExplorerOutput = CompletedExplorerOutput | PartialExplorerOutput;
export type ExplorerOutputValidation = UsableExplorerOutput | InvalidExplorerOutput;

function extractFinalBlock(text: unknown): Readonly<{ block: string | null; recovered: boolean }> {
  const rawText = String(text || "");
  const matches = [...rawText.matchAll(/<final_answer>([\s\S]*?)<\/final_answer>/giu)];
  const complete = matches.at(-1)?.[1];
  if (complete !== undefined) return { block: complete.trim(), recovered: false };

  const opening = [...rawText.matchAll(/<final_answer>/giu)].at(-1);
  if (opening?.index === undefined) return { block: null, recovered: false };
  return {
    block: rawText.slice(opening.index + opening[0].length).trim(),
    recovered: true,
  };
}

function cleanPath(value: string): string {
  return value.trim().replace(/^`|`$/gu, "").replace(/^\.\//u, "").replace(/\\/gu, "/");
}

function parseEvidenceLine(line: string, evidence: EvidenceCitation[], problems: string[]): void {
  if (!/^[-*]\s+/u.test(line)) {
    if (line && !/^none$/iu.test(line)) problems.push("Malformed evidence line.");
    return;
  }
  const content = line.replace(/^[-*]\s+/u, "").trim();
  const match = content.match(/^(.+):(\d+(?:-\d+)?(?:,\s*\d+(?:-\d+)?)*)\s+(?:—|–|-)\s+(.+)$/u);
  const pathValue = match?.[1];
  const rangesValue = match?.[2];
  const reasonValue = match?.[3];
  if (!pathValue || !rangesValue || !reasonValue) {
    problems.push("Malformed evidence citation.");
    return;
  }
  for (const range of rangesValue.split(",").map((value) => value.trim())) {
    const [startValue, endValue] = range.split("-", 2);
    if (!startValue) continue;
    const start = Number.parseInt(startValue, 10);
    const end = Number.parseInt(endValue || startValue, 10);
    evidence.push({ path: cleanPath(pathValue), start, end, reason: reasonValue.trim() });
  }
}

export function parseFinalBlock(text: unknown): ParsedFinalBlock {
  const rawText = String(text || "");
  const extracted = extractFinalBlock(rawText);
  if (extracted.block === null) {
    return {
      rawText,
      block: null,
      summary: "",
      evidence: [],
      gaps: [],
      problems: ["Missing <final_answer> block."],
    };
  }

  const block = extracted.block;
  const problems: string[] = extracted.recovered
    ? ["Missing closing </final_answer>; recovered trailing block."]
    : [];
  const evidence: EvidenceCitation[] = [];
  const gaps: string[] = [];
  let section: "summary" | "evidence" | "gaps" | null = null;
  let summary = "";

  for (const rawLine of block.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const summaryMatch = line.match(/^summary\s*:\s*(.*)$/iu);
    if (summaryMatch) {
      summary = summaryMatch[1]?.trim() ?? "";
      section = "summary";
      continue;
    }
    if (/^evidence\s*:\s*$/iu.test(line)) {
      section = "evidence";
      continue;
    }
    const inlineEvidence = line.match(/^evidence\s*:\s*(.+)$/iu);
    if (inlineEvidence?.[1]) {
      section = "evidence";
      parseEvidenceLine(`- ${inlineEvidence[1]}`, evidence, problems);
      continue;
    }
    if (/^gaps\s*:\s*$/iu.test(line)) {
      section = "gaps";
      continue;
    }
    const inlineGap = line.match(/^gaps\s*:\s*(.*)$/iu);
    if (inlineGap) {
      section = "gaps";
      const gap = inlineGap[1]?.trim();
      if (gap) gaps.push(gap);
      continue;
    }

    if (section === "evidence") parseEvidenceLine(line, evidence, problems);
    else if (section === "gaps") gaps.push(line.replace(/^[-*]\s*/u, "").trim());
    else if (section === "summary") summary = `${summary} ${line}`.trim();
  }

  if (!summary) problems.push("Missing non-empty summary.");
  if (evidence.length === 0) problems.push("No parseable evidence citations were returned.");
  if (gaps.length === 0) gaps.push("none");
  return { rawText, block, summary, evidence, gaps, problems };
}

async function countLines(filePath: string): Promise<number> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const _line of reader) count += 1;
  } finally {
    reader.close();
    stream.destroy();
  }
  return count;
}

function mergeValidationGaps(gaps: readonly string[], problems: readonly string[]): readonly string[] {
  const candidates = problems.length > 0
    ? gaps.filter((gap) => !/^none$/iu.test(gap.trim()))
    : gaps;
  const merged = [...candidates, ...problems.map((problem) => `Validation: ${problem}`)];
  const deduplicated = [...new Set(merged.filter(Boolean))];
  return deduplicated.length > 0 ? deduplicated : ["none"];
}

export async function validateExplorerOutput(text: unknown, workspace: Workspace): Promise<ExplorerOutputValidation> {
  const parsed = parseFinalBlock(text);
  const problems = [...parsed.problems];
  const validEvidence: ValidatedEvidenceCitation[] = [];
  const seen = new Set<string>();
  const lineCounts = new Map<string, number>();

  for (const item of parsed.evidence) {
    if (!item.path || item.path === ".") {
      problems.push("Evidence path is invalid.");
      continue;
    }
    if (!Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) || item.start < 1 || item.end < item.start || item.end > MAX_EVIDENCE_LINE) {
      problems.push("Invalid evidence line range.");
      continue;
    }
    let target;
    try {
      target = await workspace.resolveExisting(item.path, { kind: "file" });
      assertDirectFileSize(target);
    } catch {
      problems.push("Evidence path rejected by workspace policy (missing, sensitive, outside, oversized, or unsupported).");
      continue;
    }
    let total = lineCounts.get(target.absolute);
    if (total === undefined) {
      total = await countLines(target.absolute);
      lineCounts.set(target.absolute, total);
    }
    if (item.start > total || item.end > total) {
      problems.push(`Line range exceeds file length: ${target.relative}:${item.start}-${item.end} (file has ${total} lines)`);
      continue;
    }
    const key = `${target.relative}:${item.start}-${item.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    validEvidence.push({ ...item, path: target.relative, totalLines: total });
  }

  const fields = {
    ...parsed,
    evidence: validEvidence,
    gaps: mergeValidationGaps(parsed.gaps, problems),
    problems,
  };
  if (parsed.block && parsed.summary && validEvidence.length > 0) {
    if (problems.length === 0) {
      return { ...fields, block: parsed.block, valid: true, status: "completed" };
    }
    return { ...fields, block: parsed.block, valid: true, status: "partial" };
  }
  return { ...fields, valid: false, status: "invalid" };
}

export function renderFinalAnswer(result: UsableExplorerOutput): string {
  const lines = ["<final_answer>", `summary: ${result.summary}`, "evidence:"];
  for (const item of result.evidence) lines.push(`- ${item.path}:${item.start}-${item.end} — ${item.reason}`);
  lines.push("gaps:");
  for (const gap of result.gaps.length ? result.gaps : ["none"]) lines.push(`- ${gap.replace(/^[-*]\s*/u, "")}`);
  lines.push("</final_answer>");
  return lines.join("\n");
}
