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

export interface ExplorerCandidate {
  readonly summary: string;
  readonly evidence: readonly ExplorerEvidenceCandidate[];
  readonly gaps: readonly ExplorerGapCandidate[];
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
