export interface ExplorerEvidenceCandidate {
  readonly role: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly focusLine: number;
  readonly questionId: string;
  readonly why: string;
}

export interface ExplorerGapCandidate {
  readonly questionId: string;
  readonly reason: string;
}

export interface ParsedExplorerCandidate {
  readonly rawText: string;
  readonly block: string | null;
  readonly summary: string;
  readonly evidence: readonly ExplorerEvidenceCandidate[];
  readonly gaps: readonly ExplorerGapCandidate[];
  readonly problems: readonly string[];
}

export function clipSingleLine(value: string, maximum: number): string {
  return [...value.replace(/\s+/gu, " ").trim()].slice(0, maximum).join("");
}

export function readTextLines(value: string): readonly string[] {
  if (value.length === 0) return Object.freeze([]);
  const lines = value.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return Object.freeze(lines);
}

function extractFinalBlock(text: unknown): Readonly<{ rawText: string; block: string | null; recovered: boolean }> {
  const rawText = String(text ?? "");
  const matches = [...rawText.matchAll(/<final_answer>([\s\S]*?)<\/final_answer>/giu)];
  const complete = matches.at(-1)?.[1];
  if (complete !== undefined) return { rawText, block: complete.trim(), recovered: false };
  const opening = [...rawText.matchAll(/<final_answer>/giu)].at(-1);
  if (opening?.index === undefined) return { rawText, block: null, recovered: false };
  return {
    rawText,
    block: rawText.slice(opening.index + opening[0].length).trim(),
    recovered: true,
  };
}

function parseEvidenceLine(line: string): ExplorerEvidenceCandidate | null {
  const content = line.replace(/^[-*]\s+/u, "").trim();
  const match = content.match(/^\[([^\]]+)\]\[([^\]]+)\]\s+(.+):(\d+)-(\d+)\s+\(focus\s+(\d+)\)\s+(?:—|–|-)\s+(.+)$/u);
  if (!match) return null;
  return {
    role: match[1]?.trim() ?? "",
    questionId: match[2]?.trim() ?? "",
    path: match[3]?.trim() ?? "",
    startLine: Number.parseInt(match[4] ?? "", 10),
    endLine: Number.parseInt(match[5] ?? "", 10),
    focusLine: Number.parseInt(match[6] ?? "", 10),
    why: match[7]?.trim() ?? "",
  };
}

function parseGapLine(line: string): ExplorerGapCandidate | null {
  const content = line.replace(/^[-*]\s+/u, "").trim();
  const match = content.match(/^\[([^\]]+)\]\s+(.+)$/u);
  return match ? { questionId: match[1]?.trim() ?? "", reason: match[2]?.trim() ?? "" } : null;
}

export function parseExplorerCandidate(text: unknown): Readonly<ParsedExplorerCandidate> {
  const extracted = extractFinalBlock(text);
  if (extracted.block === null) {
    return Object.freeze({
      rawText: extracted.rawText,
      block: null,
      summary: "",
      evidence: Object.freeze([]),
      gaps: Object.freeze([]),
      problems: Object.freeze(["Missing <final_answer> block."]),
    });
  }

  const evidence: ExplorerEvidenceCandidate[] = [];
  const gaps: ExplorerGapCandidate[] = [];
  const problems: string[] = extracted.recovered ? ["Missing closing </final_answer>."] : [];
  let section: "summary" | "evidence" | "gaps" | null = null;
  let summary = "";
  for (const rawLine of extracted.block.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const summaryMatch = line.match(/^summary\s*:\s*(.*)$/iu);
    if (summaryMatch) {
      summary = summaryMatch[1]?.trim() ?? "";
      section = "summary";
    } else if (/^evidence\s*:\s*$/iu.test(line)) {
      section = "evidence";
    } else if (/^gaps\s*:\s*$/iu.test(line)) {
      section = "gaps";
    } else if (section === "summary") {
      summary = `${summary} ${line}`.trim();
    } else if (section === "evidence") {
      const item = parseEvidenceLine(line);
      if (item) evidence.push(item);
      else if (line !== "-") problems.push("Malformed evidence line.");
    } else if (section === "gaps") {
      const gap = parseGapLine(line);
      if (gap) gaps.push(gap);
      else if (line !== "-") problems.push("Malformed gap line.");
    }
  }
  if (!summary) problems.push("Missing non-empty summary.");
  return Object.freeze({
    rawText: extracted.rawText,
    block: extracted.block,
    summary,
    evidence: Object.freeze(evidence),
    gaps: Object.freeze(gaps),
    problems: Object.freeze(problems),
  });
}
