import type { ParentRepositoryActionEvent } from "./consumption-analysis.js";

const MAX_LINE = Number.MAX_SAFE_INTEGER;
const PATCH_PATH_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu;
const SEARCH_VALUE_OPTIONS = new Map<string, ReadonlySet<string>>([
  ["rg", new Set(["-A", "--after-context", "-B", "--before-context", "-C", "--context", "-d", "--max-depth", "-e", "--regexp", "-f", "--file", "-g", "--glob", "--iglob", "--ignore-file", "-j", "--threads", "-m", "--max-count", "--engine", "--sort", "--sortr", "-t", "--type", "-T", "--type-not"])],
  ["grep", new Set(["-A", "--after-context", "-B", "--before-context", "-C", "--context", "-e", "--regexp", "-f", "--file", "-m", "--max-count", "--exclude", "--exclude-from", "--include"])],
  ["fd", new Set(["-d", "--max-depth", "-E", "--exclude", "-e", "--extension", "-j", "--threads", "-t", "--type"])],
]);
const SEARCH_PATTERN_OPTIONS = new Set(["-e", "--regexp", "-f", "--file"]);

export interface RepositoryAction {
  readonly kind: ParentRepositoryActionEvent["action"]["kind"];
  readonly path: string | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly broad: boolean;
  readonly gapQuestionIds: readonly string[];
}

export interface ExtractedRepositoryActions {
  readonly complete: boolean;
  readonly actions: readonly RepositoryAction[];
}

function parseDoubleQuoted(source: string, quoteIndex: number): string | null {
  let escaped = false;
  for (let index = quoteIndex + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character !== "\"") continue;
    try {
      return JSON.parse(source.slice(quoteIndex, index + 1)) as string;
    } catch {
      return null;
    }
  }
  return null;
}

function stringProperty(source: string, name: string): string | null {
  const match = source.match(new RegExp(`\\b${name}\\s*:\\s*\"`, "u"));
  if (!match || match.index === undefined) return null;
  return parseDoubleQuoted(source, match.index + match[0].length - 1);
}

function firstStringArgument(source: string): string | null {
  const open = source.indexOf("(");
  if (open < 0) return null;
  const quote = source.indexOf("\"", open + 1);
  if (quote < 0 || source.slice(open + 1, quote).trim()) return null;
  return parseDoubleQuoted(source, quote);
}

function splitShell(command: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (character !== "\n" && character !== ";" && character !== "|" && pair !== "&&" && pair !== "||") continue;
    const segment = command.slice(start, index).trim();
    if (segment) segments.push(segment);
    if (pair === "&&" || pair === "||") index += 1;
    start = index + 1;
  }
  const final = command.slice(start).trim();
  if (final) segments.push(final);
  return segments;
}

function shellTokens(segment: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  const flush = (): void => {
    if (token) tokens.push(token);
    token = "";
  };
  for (const character of segment) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) flush();
    else token += character;
  }
  flush();
  return tokens;
}

function normalizedPath(value: string | undefined): string | null {
  if (!value || value.startsWith("-") || /[*?{}<>|&;]/u.test(value)) return null;
  const normalized = value.replace(/\\/gu, "/").replace(/^\.\//u, "");
  const relative = normalized.startsWith("/app/") ? normalized.slice(5) : normalized;
  if (relative.startsWith("/") || relative.split("/").includes("..") || !relative) return null;
  return relative;
}

function action(kind: RepositoryAction["kind"], path: string | null, startLine: number | null,
  endLine: number | null, broad = false, gapQuestionIds: readonly string[] = []): RepositoryAction {
  return { kind, path, startLine, endLine, broad, gapQuestionIds };
}

function searchPositionals(name: string, args: readonly string[]): {
  readonly values: readonly string[];
  readonly patternFromOption: boolean;
} {
  const values: string[] = [];
  const valueOptions = SEARCH_VALUE_OPTIONS.get(name) ?? new Set<string>();
  let patternFromOption = false;
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item || item === "2>/dev/null") continue;
    if (item === "--") {
      values.push(...args.slice(index + 1));
      break;
    }
    const optionName = item.startsWith("--") ? item.split("=", 1)[0] ?? item : item;
    if (valueOptions.has(optionName)) {
      if (SEARCH_PATTERN_OPTIONS.has(optionName)) patternFromOption = true;
      if (!item.includes("=")) index += 1;
      continue;
    }
    if (item.startsWith("-")) continue;
    values.push(item);
  }
  return { values, patternFromOption };
}

function searchIsBroad(name: string, args: readonly string[]): boolean {
  if (name === "find") {
    const roots: string[] = [];
    for (const item of args) {
      if (item === "2>/dev/null") continue;
      if (["-H", "-L", "-P"].includes(item)) continue;
      if (item.startsWith("-")) break;
      roots.push(item);
    }
    return roots.length === 0 || roots.some((item) => item === "." || item === "./");
  }
  const { values, patternFromOption } = searchPositionals(name, args);
  const paths = name === "fd" || !patternFromOption ? values.slice(1) : values;
  return paths.length === 0 || paths.some((item) => item === "." || item === "./");
}

function commandActions(command: string, gapQuestionIds: readonly string[]): RepositoryAction[] | null {
  const actions: RepositoryAction[] = [];
  for (const segment of splitShell(command)) {
    const tokens = shellTokens(segment);
    if (tokens.length === 0) continue;
    let name = tokens[0]?.split("/").at(-1) ?? "";
    let args = tokens.slice(1);
    if (name === "rtk" && args[0]) {
      name = args[0];
      args = args.slice(1);
    }
    const recognized = ["rg", "fd", "grep", "find", "sed", "bat", "read", "head", "cat"].includes(name);
    if (recognized && tokens.some((item) => item !== "2>/dev/null" && /^(?:\d*)?[<>]/u.test(item))) return null;
    if (["rg", "fd", "grep", "find"].includes(name)) {
      actions.push(action("search", null, null, null, searchIsBroad(name, args), gapQuestionIds));
      continue;
    }
    if (name === "sed") {
      const rangeIndex = args.findIndex((item) => /^(\d+)(?:,(\d+))?p$/u.test(item));
      const range = rangeIndex < 0 ? null : (args[rangeIndex] ?? "").match(/^(\d+)(?:,(\d+))?p$/u);
      const path = normalizedPath(rangeIndex < 0 ? undefined : args.slice(rangeIndex + 1).find((item) => !item.startsWith("-")));
      if (range && path) actions.push(action("read", path, Number(range[1]), Number(range[2] ?? range[1])));
      continue;
    }
    if (name === "bat" || name === "read") {
      const joined = args.join(" ");
      const range = joined.match(/--line-range(?:=|\s+)(\d+):(\d+)/u);
      const maximum = joined.match(/(?:^|\s)(?:-m|--max-lines)(?:=|\s+)(\d+)/u);
      const path = normalizedPath([...args].reverse().find((item) => !item.startsWith("-") && !/^\d+(?::\d+)?$/u.test(item)));
      if (path && !joined.includes("--tail-lines")) {
        actions.push(action("read", path, range ? Number(range[1]) : 1, range ? Number(range[2]) : Number(maximum?.[1] ?? MAX_LINE)));
      }
      continue;
    }
    if (name === "head") {
      const countIndex = args.findIndex((item) => item === "-n" || item === "--lines");
      const count = countIndex < 0 ? 10 : Number(args[countIndex + 1]);
      const path = normalizedPath([...args].reverse().find((item) => !item.startsWith("-") && !/^\d+$/u.test(item)));
      if (path && Number.isSafeInteger(count) && count > 0) actions.push(action("read", path, 1, count));
      continue;
    }
    if (name === "cat") {
      for (const candidate of args) {
        const path = normalizedPath(candidate);
        if (path) actions.push(action("read", path, 1, MAX_LINE));
      }
    }
  }
  return actions;
}

export function extractRepositoryActionsFromCode(
  source: string,
  gapQuestionIds: readonly string[],
): Readonly<ExtractedRepositoryActions> {
  const markers = [...source.matchAll(/tools\.(exec_command|apply_patch)\s*\(/gu)];
  const concurrent = source.includes("Promise.all") && markers.length > 1;
  const actions: RepositoryAction[] = [];
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    if (!marker) continue;
    const block = source.slice(marker.index, markers[index + 1]?.index ?? source.length);
    if (marker[1] === "exec_command") {
      const command = stringProperty(block, "cmd");
      if (command === null) return { complete: false, actions: [] };
      const commandResult = commandActions(command, gapQuestionIds);
      if (commandResult === null) return { complete: false, actions: [] };
      actions.push(...commandResult);
    } else {
      const patch = firstStringArgument(block);
      if (patch === null) {
        actions.push(action("edit", null, null, null));
      } else {
        for (const match of patch.matchAll(PATCH_PATH_RE)) {
          const path = normalizedPath(match[1]);
          if (path) actions.push(action("edit", path, null, null));
        }
      }
    }
  }
  if (concurrent && actions.length > 1) return { complete: false, actions: [] };
  return { complete: true, actions };
}
