import { createReadStream } from "node:fs";
import readline from "node:readline";
import { assertDirectFileSize } from "../tools/workspace.mjs";

const MAX_EVIDENCE_LINE = 10_000_000;

function extractFinalBlock(text) {
  const matches = [...String(text || "").matchAll(/<final_answer>([\s\S]*?)<\/final_answer>/giu)];
  return matches.length ? matches.at(-1)[1].trim() : null;
}

function cleanPath(value) {
  return value.trim().replace(/^`|`$/gu, "").replace(/^\.\//u, "").replace(/\\/gu, "/");
}

export function parseFinalBlock(text) {
  const block = extractFinalBlock(text);
  const problems = [];
  if (!block) {
    return {
      rawText: String(text || ""),
      block: null,
      summary: "",
      evidence: [],
      gaps: [],
      problems: ["Missing <final_answer> block."],
    };
  }

  const lines = block.split(/\r?\n/u);
  let section = null;
  let summary = "";
  const evidence = [];
  const gaps = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const summaryMatch = line.match(/^summary\s*:\s*(.*)$/iu);
    if (summaryMatch) {
      summary = summaryMatch[1].trim();
      section = "summary";
      continue;
    }
    if (/^evidence\s*:\s*$/iu.test(line)) {
      section = "evidence";
      continue;
    }
    const inlineEvidence = line.match(/^evidence\s*:\s*(.+)$/iu);
    if (inlineEvidence) {
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
      if (inlineGap[1].trim()) gaps.push(inlineGap[1].trim());
      continue;
    }

    if (section === "evidence") {
      parseEvidenceLine(line, evidence, problems);
    } else if (section === "gaps") {
      gaps.push(line.replace(/^[-*]\s*/u, "").trim());
    } else if (section === "summary") {
      summary = `${summary} ${line}`.trim();
    }
  }

  if (!summary) problems.push("Missing non-empty summary.");
  if (evidence.length === 0) problems.push("No parseable evidence citations were returned.");
  if (gaps.length === 0) gaps.push("none");

  return { rawText: String(text || ""), block, summary, evidence, gaps, problems };
}

function parseEvidenceLine(line, evidence, problems) {
  if (!/^[-*]\s+/u.test(line)) {
    if (line && !/^none$/iu.test(line)) problems.push(`Malformed evidence line: ${line}`);
    return;
  }
  const content = line.replace(/^[-*]\s+/u, "").trim();
  const match = content.match(/^(.+):(\d+)(?:-(\d+))?\s+(?:—|–|-)\s+(.+)$/u);
  if (!match) {
    problems.push(`Malformed evidence citation: ${content}`);
    return;
  }
  const start = Number.parseInt(match[2], 10);
  const end = Number.parseInt(match[3] || match[2], 10);
  evidence.push({
    path: cleanPath(match[1]),
    start,
    end,
    reason: match[4].trim(),
  });
}

async function countLines(filePath) {
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

export async function validateExplorerOutput(text, workspace) {
  const parsed = parseFinalBlock(text);
  const problems = [...parsed.problems];
  const validEvidence = [];
  const seen = new Set();
  const lineCounts = new Map();

  for (const item of parsed.evidence) {
    if (!item.path || item.path === ".") {
      problems.push(`Evidence path is invalid: ${item.path || "<empty>"}`);
      continue;
    }
    if (
      !Number.isSafeInteger(item.start) ||
      !Number.isSafeInteger(item.end) ||
      item.start < 1 ||
      item.end < item.start ||
      item.end > MAX_EVIDENCE_LINE
    ) {
      problems.push(`Invalid line range: ${item.path}:${item.start}-${item.end}`);
      continue;
    }
    let target;
    try {
      target = await workspace.resolveExisting(item.path, { kind: "file" });
    } catch (error) {
      problems.push(`Invalid evidence path ${item.path}: ${error.message}`);
      continue;
    }
    try {
      assertDirectFileSize(target);
    } catch (error) {
      problems.push(`Invalid evidence path ${item.path}: ${error.message}`);
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

  return {
    ...parsed,
    evidence: validEvidence,
    problems,
    valid: Boolean(parsed.block && parsed.summary && validEvidence.length > 0 && problems.length === 0),
  };
}

export function renderFinalAnswer(result) {
  const lines = ["<final_answer>", `summary: ${result.summary || "Repository evidence could not be validated."}`, "evidence:"];
  if (result.evidence.length) {
    for (const item of result.evidence) {
      lines.push(`- ${item.path}:${item.start}-${item.end} — ${item.reason}`);
    }
  } else {
    lines.push("- none");
  }
  lines.push("gaps:");
  for (const gap of result.gaps?.length ? result.gaps : ["none"]) lines.push(`- ${gap.replace(/^[-*]\s*/u, "")}`);
  lines.push("</final_answer>");
  return lines.join("\n");
}
