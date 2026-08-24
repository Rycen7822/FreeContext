import type { ParentRepositoryActionEvent } from "./consumption-analysis.js";

const MAX_LINE = Number.MAX_SAFE_INTEGER;
const PATCH_PATH_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu;
const SEARCH_VALUE_OPTIONS = new Map<string, ReadonlySet<string>>([
  ["rg", new Set(["-A", "--after-context", "-B", "--before-context", "-C", "--context", "-d", "--max-depth", "-e", "--regexp", "-f", "--file", "-g", "--glob", "--iglob", "--ignore-file", "-j", "--threads", "-m", "--max-count", "--engine", "--sort", "--sortr", "-t", "--type", "-T", "--type-not"])],
  ["grep", new Set(["-A", "--after-context", "-B", "--before-context", "-C", "--context", "-e", "--regexp", "-f", "--file", "-m", "--max-count", "--exclude", "--exclude-from", "--include"])],
  ["fd", new Set(["-d", "--max-depth", "-E", "--exclude", "-e", "--extension", "-j", "--threads", "-t", "--type"])],
]);
const SEARCH_PATTERN_OPTIONS = new Set(["-e", "--regexp", "-f", "--file"]);
const DIRECT_CHECK_COMMANDS = new Set(["eslint", "jest", "mypy", "nox", "pytest", "ruff", "tox", "tsc", "vitest"]);
const CHECK_SCRIPT_NAMES = new Set(["build", "check", "lint", "test", "typecheck"]);

export interface RepositoryAction {
  readonly kind: ParentRepositoryActionEvent["action"]["kind"];
  readonly path: string | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly broad: boolean;
  readonly gapQuestionIds: readonly string[];
  readonly pathOnlyProbe?: true;
  readonly externalSource?: true;
}

export interface ExtractedRepositoryActions {
  readonly complete: boolean;
  readonly actions: readonly RepositoryAction[];
  readonly concurrent: boolean;
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

function staticTupleMappedCommands(source: string): readonly string[] | null {
  const declaration = source.match(
    /\bconst\s+([A-Za-z_]\w*)\s*=\s*(\[[\s\S]*?\])\s*;/u,
  );
  if (!declaration?.[1] || !declaration[2]) return null;
  const binding = source.match(new RegExp(
    "\\b" + declaration[1] +
      "\\.map\\(\\s*async\\s*\\(\\s*\\[\\s*([A-Za-z_]\\w*)\\s*,\\s*([A-Za-z_]\\w*)\\s*\\]",
    "u",
  ));
  const commandProperty = source.match(
    /tools\.exec_command\s*\(\s*\{\s*([A-Za-z_]\w*)\s*[,}]/u,
  );
  const commandIndex = binding && commandProperty
    ? [binding[1], binding[2]].indexOf(commandProperty[1])
    : -1;
  if (commandIndex < 0) return null;
  try {
    const value: unknown = JSON.parse(declaration[2]);
    if (!Array.isArray(value) || value.length === 0 ||
        !value.every((entry) => Array.isArray(entry) && typeof entry[commandIndex] === "string")) return null;
    return value.map((entry) => (entry as readonly unknown[])[commandIndex] as string);
  } catch {
    return null;
  }
}

function staticTemplateMappedCommands(source: string): readonly string[] | null {
  const mapping = source.match(
    /\b([A-Za-z_]\w*)\.map\(\s*(?:async\s*)?(?:\(\s*)?([A-Za-z_]\w*)\s*(?:,\s*([A-Za-z_]\w*))?\s*\)?\s*=>[\s\S]*?tools\.exec_command/u,
  );
  const template = source.match(/tools\.exec_command\s*\(\s*\{[\s\S]*?\bcmd\s*:\s*`([^`]*)`/u)?.[1];
  if (!mapping?.[1] || !mapping[2] || template === undefined) return null;

  const arrays = new Map<string, readonly unknown[]>();
  for (const declaration of source.matchAll(/\bconst\s+([A-Za-z_]\w*)\s*=\s*(\[[\s\S]*?\])\s*;/gu)) {
    if (!declaration[1] || !declaration[2]) continue;
    try {
      const value: unknown = JSON.parse(declaration[2]);
      if (Array.isArray(value)) arrays.set(declaration[1], value);
    } catch { /* Non-JSON declarations remain dynamic and fail closed. */ }
  }
  const values = arrays.get(mapping[1]);
  if (!values?.length || !values.every((value) => typeof value === "string")) return null;

  const indexPattern = mapping[3]
    ? new RegExp(`\\$\\{([A-Za-z_]\\w*)\\[${mapping[3]}\\]\\}`, "gu")
    : null;
  const commands = values.map((value, index) => {
    let command = template.replaceAll(`\${${mapping[2]}}`, () => value as string);
    if (indexPattern) {
      command = command.replace(indexPattern, (placeholder, name: string) => {
        const replacement = arrays.get(name)?.[index];
        return typeof replacement === "string" ? replacement : placeholder;
      });
    }
    return command;
  });
  return commands.every((command) => !command.includes("${")) ? commands : null;
}

function staticMappedCommands(source: string): readonly string[] | null {
  if (!source.includes("Promise.all")) return null;
  return staticTupleMappedCommands(source) ?? staticTemplateMappedCommands(source);
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
  endLine: number | null, broad = false, gapQuestionIds: readonly string[] = [],
  pathOnlyProbe = false, externalSource = false): RepositoryAction {
  const value = { kind, path, startLine, endLine, broad, gapQuestionIds };
  return { ...value, ...(pathOnlyProbe ? { pathOnlyProbe: true as const } : {}), ...(externalSource ? { externalSource: true as const } : {}) };
}

function isTaskSolutionExternalSource(name: string, args: readonly string[]): boolean {
  if (name === "curl" || name === "wget") return true;
  if (name === "git" && ["clone", "fetch", "ls-remote"].includes(args[0] ?? "")) return true;
  if (["npm", "pnpm", "yarn", "bun"].includes(name) && ["view", "info", "pack"].includes(args[0] ?? "")) return true;
  if ((name === "pip" || /^pip\d+(?:\.\d+)?$/u.test(name)) && ["download", "index", "install"].includes(args[0] ?? "")) return true;
  if (name === "cargo" && ["search", "info", "install"].includes(args[0] ?? "")) return true;
  if (name === "go" && args[0] === "list" && args.includes("-m")) return true;
  return name === "gh" && (args[0] === "api" || args[0] === "repo");
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

function pathOnlySearch(command: string): boolean {
  if (/\n|;|&&|\|\|/u.test(command)) return false;
  const commands = splitShell(command).map((segment) => {
    const tokens = shellTokens(segment);
    let name = tokens[0]?.split("/").at(-1) ?? "";
    let args = tokens.slice(1);
    if (name === "rtk" && args[0]) {
      name = args[0];
      args = args.slice(1);
    }
    return { name, args };
  });
  const first = commands[0];
  if (!first || first.name !== "rg" || !first.args.includes("--files")) return false;
  return commands.slice(1).every(({ name, args }) => {
    if (name !== "rg" && name !== "grep") return false;
    const { values, patternFromOption } = searchPositionals(name, args);
    return (patternFromOption ? values : values.slice(1)).length === 0;
  });
}

function isCheckCommand(name: string, args: readonly string[]): boolean {
  if (DIRECT_CHECK_COMMANDS.has(name)) return true;
  if ((name === "python" || /^python\d+(?:\.\d+)?$/u.test(name)) && args[0] === "-m") {
    return ["mypy", "pytest", "unittest"].includes(args[1] ?? "");
  }
  if (name === "node") return args.includes("--test");
  if (name === "cargo") return ["check", "clippy", "test"].includes(args[0] ?? "");
  if (name === "go") return args[0] === "test";
  if (["npm", "pnpm", "yarn", "bun"].includes(name)) {
    const script = args[0] === "run" ? args[1] : args[0];
    return CHECK_SCRIPT_NAMES.has(script ?? "");
  }
  if (name === "make") return args.some((target) => CHECK_SCRIPT_NAMES.has(target));
  if ((name === "uv" || name === "poetry") && args[0] === "run" && args[1]) {
    return isCheckCommand(args[1].split("/").at(-1) ?? "", args.slice(2));
  }
  if (name === "test" && args[0]) {
    return isCheckCommand(args[0].split("/").at(-1) ?? "", args.slice(1));
  }
  return false;
}

function commandActions(command: string, gapQuestionIds: readonly string[]): RepositoryAction[] | null {
  const actions: RepositoryAction[] = [];
  // Stderr suppression is read-only; remove it before token safety checks so
  // substitutions such as `$(go env GOPATH 2>/dev/null)` are not mistaken for
  // a write redirection. All other redirections remain fail-closed below.
  const normalizedCommand = command.replace(/2>\s*\/dev\/null/gu, "");
  const pathOnlyProbe = pathOnlySearch(normalizedCommand);
  for (const segment of splitShell(normalizedCommand)) {
    const tokens = shellTokens(segment);
    if (tokens.length === 0) continue;
    let name = tokens[0]?.split("/").at(-1) ?? "";
    let args = tokens.slice(1);
    if (name === "rtk" && args[0]) {
      name = args[0];
      args = args.slice(1);
    }
    if (isTaskSolutionExternalSource(name, args)) {
      actions.push(action("other", null, null, null, true, gapQuestionIds, false, true));
      continue;
    }
    if (isCheckCommand(name, args)) {
      actions.push(action("check", null, null, null));
      continue;
    }
    const recognized = ["rg", "fd", "grep", "find", "sed", "bat", "read", "head", "cat"].includes(name);
    if (recognized && tokens.some((item) => item !== "2>/dev/null" && /^(?:\d*)?[<>]/u.test(item))) return null;
    if (["rg", "fd", "grep", "find"].includes(name)) {
      actions.push(action("search", null, null, null, searchIsBroad(name, args), gapQuestionIds, pathOnlyProbe));
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
  const mappedCommands = markers.length === 1 ? staticMappedCommands(source) : null;
  const concurrent = source.includes("Promise.all") &&
    (markers.length > 1 || (mappedCommands?.length ?? 0) > 1);
  const actions: RepositoryAction[] = [];
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    if (!marker) continue;
    const block = source.slice(marker.index, markers[index + 1]?.index ?? source.length);
    if (marker[1] === "exec_command") {
      const command = stringProperty(block, "cmd");
      const commands = command === null ? mappedCommands : [command];
      if (commands === null) return { complete: false, actions: [], concurrent };
      for (const current of commands) {
        const commandResult = commandActions(current, gapQuestionIds);
        if (commandResult === null) return { complete: false, actions: [], concurrent };
        actions.push(...commandResult);
      }
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
  return { complete: true, actions, concurrent: concurrent && actions.length > 1 };
}

function unwrapCommandExecution(command: string): string {
  const tokens = shellTokens(command);
  const shell = tokens[0]?.split("/").at(-1);
  if ((shell === "bash" || shell === "sh" || shell === "zsh") && tokens[1] === "-lc") {
    return tokens.slice(2).join(" ");
  }
  return command;
}

export function extractRepositoryActionsFromShellCommand(
  command: string,
  gapQuestionIds: readonly string[],
): Readonly<ExtractedRepositoryActions> {
  const actions = commandActions(unwrapCommandExecution(command), gapQuestionIds);
  return Object.freeze({ complete: actions !== null, actions: Object.freeze(actions ?? []), concurrent: false });
}
