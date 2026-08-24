export interface ExplorerEvidenceCandidate {
  readonly role: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly focusLine: number;
  readonly questionId: string;
  readonly targetId?: string | undefined;
  readonly coverageBasis?: boolean | undefined;
  readonly why: string;
}

export interface ExplorerGapCandidate {
  readonly questionId: string;
  readonly targetId?: string | undefined;
  readonly reason: string;
}

export interface ExplorerCoverageCandidate {
  readonly targetId: string;
  readonly members: readonly string[];
  readonly gaps: readonly string[];
}

export interface ExplorerCandidate {
  readonly summary: string;
  readonly evidence: readonly ExplorerEvidenceCandidate[];
  readonly gaps: readonly ExplorerGapCandidate[];
  readonly coverage?: readonly ExplorerCoverageCandidate[] | undefined;
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
