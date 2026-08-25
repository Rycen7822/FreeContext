import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Static } from "@earendil-works/pi-ai";
import { isSensitiveRelativePath, SENSITIVE_RG_GLOBS } from "./workspace.js";
import { runCommand, sanitizedToolEnv } from "./process.js";
import type { ExternalToolContext } from "./contracts.js";

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  return Math.min(max, Math.max(min, Number.parseInt(String(value), 10)));
}

function limitLines(text: string, maxLines: number): Readonly<{ text: string; truncated: boolean }> {
  const lines = text.split(/\r?\n/u);
  const nonTerminalLength = lines.at(-1) === "" ? lines.length - 1 : lines.length;
  if (nonTerminalLength <= maxLines) return { text: lines.slice(0, nonTerminalLength).join("\n"), truncated: false };
  return { text: lines.slice(0, maxLines).join("\n"), truncated: true };
}

function extractResultPath(line: string): string | null {
  const match = line.match(/^(.+?)(?=[:\-]\d+(?::|-)\d+(?::|-))/u);
  return match?.[1] || null;
}

function removeSensitiveResultLines(text: string): string {
  return text
    .split(/\r?\n/u)
    .filter((line) => {
      const candidate = extractResultPath(line);
      return !candidate || !isSensitiveRelativePath(candidate);
    })
    .join("\n");
}

interface RgToolDetails {
  readonly tool: "rg";
  readonly pattern: string;
  readonly path: string;
  readonly noMatches: boolean;
  readonly truncated: boolean;
  readonly exitCode: number | null;
}

export function createRgTool({ Type, workspace, semaphore, config, executable }: ExternalToolContext) {
  const parameters = Type.Object({
    pattern: Type.String({ minLength: 1, maxLength: 4000, description: "Regex or literal search pattern." }),
    path: Type.Optional(Type.String({ description: "Repository-relative file or directory; defaults to workspace root." })),
    glob: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
        maxItems: 16,
        description: "Optional ripgrep glob filters, for example **/*.ts or !**/generated/**.",
      }),
    ),
    literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a fixed string." })),
    ignore_case: Type.Optional(Type.Boolean({ description: "Case-insensitive matching." })),
    multiline: Type.Optional(Type.Boolean({ description: "Allow matches across lines." })),
    context_before: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
    context_after: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
    max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  });
  const tool: AgentTool<typeof parameters, RgToolDetails> = {
    name: "rg",
    label: "Ripgrep repository",
    description:
      "Search repository text with ripgrep. With path-backed knownRefs and no observed read, read the exact knownRef first; an immediate-parent probe is allowed only with literal=true, an explicit non-recursive glob filter, and a small result bound. Root, higher-ancestor, and broad recursive first-pass search is blocked. Read-only; no shell is involved.",
    parameters,
    executionMode: "parallel",
    execute: async (_toolCallId: string, params: Static<typeof parameters>, signal?: AbortSignal) =>
      await semaphore.run(async () => {
        const target = await workspace.resolveExisting(params.path || ".", { kind: "any" });
        const maxResults = boundedInteger(params.max_results, 200, 1, 500);
        const args = [
          "--line-number",
          "--column",
          "--no-heading",
          "--color=never",
          "--hidden",
          "--no-messages",
          "--max-columns=500",
          "--max-columns-preview",
        ];
        if (params.literal) args.push("--fixed-strings");
        if (params.ignore_case) args.push("--ignore-case");
        else args.push("--smart-case");
        if (params.multiline) args.push("--multiline", "--multiline-dotall");
        const before = boundedInteger(params.context_before, 0, 0, 20);
        const after = boundedInteger(params.context_after, 0, 0, 20);
        if (before) args.push("--before-context", String(before));
        if (after) args.push("--after-context", String(after));
        // User filters come first. Mandatory exclusions are deliberately last so
        // a model-supplied positive glob cannot re-include protected files.
        for (const glob of params.glob || []) args.push("--glob", glob);
        if (target.stat.isDirectory()) {
          for (const glob of SENSITIVE_RG_GLOBS) args.push("--glob", glob);
        }
        args.push("--", params.pattern, target.relative);

        const result = await runCommand({
          command: executable,
          args,
          cwd: workspace.root,
          signal,
          timeoutMs: config.toolTimeoutMs,
          maxOutputBytes: config.effectiveToolOutputBytes,
          env: sanitizedToolEnv({ RIPGREP_CONFIG_PATH: process.platform === "win32" ? "NUL" : "/dev/null" }),
        });
        if (result.timedOut) throw new Error(`rg timed out after ${config.toolTimeoutMs} ms`);
        if (result.code !== 0 && result.code !== 1) {
          throw new Error(`rg failed with exit code ${result.code}: ${result.stderr.trim() || "unknown error"}`);
        }
        const filtered = removeSensitiveResultLines(result.stdout);
        const limited = limitLines(filtered, maxResults);
        const noMatches = result.code === 1 || limited.text === "";
        const header = `[rg path=${target.relative}]`;
        const body = noMatches ? "<no matches>" : limited.text;
        const truncated = result.truncated || limited.truncated;
        return {
          content: [{ type: "text", text: `${header}\n${body}${truncated ? "\n<results truncated>" : ""}` }],
          details: {
            tool: "rg",
            pattern: params.pattern,
            path: target.relative,
            noMatches,
            truncated,
            exitCode: result.code,
          },
        };
      }, signal),
  };
  return tool;
}
