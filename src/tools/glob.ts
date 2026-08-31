import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Static } from "@earendil-works/pi-ai";
import { isSensitiveRelativePath, SENSITIVE_RG_GLOBS } from "./workspace.js";
import { runCommand, sanitizedToolEnv } from "./process.js";
import type { ExternalToolContext } from "./contracts.js";

interface GlobToolDetails {
  readonly tool: "glob";
  readonly path: string;
  readonly count: number;
  readonly truncated: boolean;
}

export function createGlobTool({ Type, workspace, semaphore, config, executable }: ExternalToolContext) {
  const parameters = Type.Object({
    pattern: Type.Optional(
      Type.String({ minLength: 1, maxLength: 512, description: "Optional glob pattern; defaults to all files. Example: **/*.py." }),
    ),
    path: Type.Optional(Type.String({ description: "Repository-relative directory; defaults to root." })),
    max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  });
  const tool: AgentTool<typeof parameters, GlobToolDetails> = {
    name: "glob",
    label: "List repository paths",
    description:
      "List files matching one optional glob pattern using ripgrep's file walker; defaults to all files. Known references are preferred starting points but do not gate discovery. Read-only.",
    parameters,
    executionMode: "parallel",
    execute: async (_toolCallId: string, params: Static<typeof parameters>, signal?: AbortSignal) =>
      await semaphore.run(async () => {
        const target = await workspace.resolveExisting(params.path || ".", { kind: "directory" });
        const maxResults = Math.min(1000, Math.max(1, params.max_results ?? 300));
        const args = ["--files", "--hidden", "--no-messages"];
        // Mandatory exclusions are appended after model-controlled patterns so
        // protected paths cannot be re-included by glob precedence.
        args.push("--glob", params.pattern || "**/*");
        for (const glob of SENSITIVE_RG_GLOBS) args.push("--glob", glob);
        args.push("--", target.relative);
        const result = await runCommand({
          command: executable,
          args,
          cwd: workspace.root,
          signal,
          timeoutMs: config.toolTimeoutMs,
          maxOutputBytes: config.effectiveToolOutputBytes,
          env: sanitizedToolEnv({ RIPGREP_CONFIG_PATH: process.platform === "win32" ? "NUL" : "/dev/null" }),
        });
        if (result.timedOut) throw new Error(`glob timed out after ${config.toolTimeoutMs} ms`);
        if (result.code !== 0 && result.code !== 1) {
          throw new Error(`glob failed with exit code ${result.code}: ${result.stderr.trim() || "unknown error"}`);
        }
        const all = result.stdout
          .split(/\r?\n/u)
          .filter(Boolean)
          .filter((candidate) => !isSensitiveRelativePath(candidate))
          .sort();
        const selected = all.slice(0, maxResults);
        const truncated = result.truncated || all.length > selected.length;
        const body = selected.length ? selected.join("\n") : "<no files matched>";
        return {
          content: [{ type: "text", text: `[glob path=${target.relative}]\n${body}${truncated ? "\n<results truncated>" : ""}` }],
          details: { tool: "glob", path: target.relative, count: selected.length, truncated },
        };
      }, signal),
  };
  return tool;
}
