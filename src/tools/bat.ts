import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Static } from "@earendil-works/pi-ai";
import { runCommand, sanitizedToolEnv } from "./process.js";
import { assertDirectFileSize } from "./workspace.js";
import type { ExternalToolContext } from "./contracts.js";

interface BatToolDetails {
  readonly tool: "bat";
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly actualEndLine: number;
  readonly truncated: boolean;
}

export function createBatTool({ Type, workspace, semaphore, config, executable }: ExternalToolContext) {
  const parameters = Type.Object({
    path: Type.String({ description: "Repository-relative file path." }),
    start_line: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000000 })),
    end_line: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000000 })),
  });
  const tool: AgentTool<typeof parameters, BatToolDetails> = {
    name: "bat",
    label: "Render file range with bat",
    description:
      "Read a bounded file range through bat with line numbers and all paging/configuration disabled. Read-only. Prefer read when exact plain output is sufficient.",
    parameters,
    executionMode: "parallel",
    execute: async (_toolCallId: string, params: Static<typeof parameters>, signal?: AbortSignal) =>
      await semaphore.run(async () => {
        const target = await workspace.resolveExisting(params.path, { kind: "file" });
        assertDirectFileSize(target);
        const startLine = params.start_line ?? 1;
        const endLine = Math.min(Math.max(params.end_line ?? startLine + 199, startLine), startLine + 399);
        const args = [
          "--paging=never",
          "--color=never",
          "--style=plain,numbers",
          "--line-range",
          `${startLine}:${endLine}`,
          "--",
          target.absolute,
        ];
        const result = await runCommand({
          command: executable,
          args,
          cwd: workspace.root,
          signal,
          timeoutMs: config.toolTimeoutMs,
          maxOutputBytes: config.effectiveToolOutputBytes,
          env: sanitizedToolEnv(),
        });
        if (result.timedOut) throw new Error(`bat timed out after ${config.toolTimeoutMs} ms`);
        if (result.code !== 0) {
          throw new Error(`bat failed with exit code ${result.code}: ${result.stderr.trim() || "unknown error"}`);
        }
        const rendered = result.stdout.trimEnd();
        const body = rendered || "<no lines in requested range>";
        const actualEndLine = rendered ? startLine + rendered.split(/\r?\n/u).length - 1 : startLine - 1;
        return {
          content: [
            {
              type: "text",
              text: `[bat ${target.relative}:${startLine}-${endLine}]\n${body}${result.truncated ? "\n<output truncated>" : ""}`,
            },
          ],
          details: { tool: "bat", path: target.relative, startLine, endLine, actualEndLine, truncated: result.truncated },
        };
      }, signal),
  };
  return tool;
}
