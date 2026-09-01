import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Static } from "@earendil-works/pi-ai";
import { readLineRange } from "./read-text.js";
import type { ReadLineRangeResult } from "./read-text.js";
import { assertDirectFileSize } from "./workspace.js";
import type { ToolContext } from "./contracts.js";

interface ReadToolDetails extends ReadLineRangeResult {
  readonly tool: "read";
  readonly path: string;
}

export function createReadTool({ Type, workspace, semaphore, config }: ToolContext) {
  const parameters = Type.Object({
    path: Type.String({ description: "Repository-relative file path." }),
    start_line: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000000, description: "First line, 1-indexed." })),
    end_line: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000000, description: "Last line, inclusive." })),
  });
  const tool: AgentTool<typeof parameters, ReadToolDetails> = {
    name: "read",
    label: "Read file range",
    description:
      "Read a bounded line range from one text file inside the repository. Returns exact line numbers. Read-only.",
    parameters,
    executionMode: "parallel",
    execute: async (_toolCallId: string, params: Static<typeof parameters>, signal?: AbortSignal) =>
      await semaphore.run(async () => {
        const target = await workspace.resolveExisting(params.path, { kind: "file" });
        assertDirectFileSize(target);
        const startLine = params.start_line ?? 1;
        const requestedEnd = params.end_line ?? startLine + 199;
        const endLine = Math.min(Math.max(requestedEnd, startLine), startLine + 399);
        const timeoutSignal = AbortSignal.timeout(config.toolTimeoutMs);
        const operationSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        let result;
        try {
          result = await readLineRange(target.absolute, {
            startLine,
            endLine,
            maxOutputBytes: config.effectiveToolOutputBytes,
            signal: operationSignal,
          });
        } catch (error) {
          if (timeoutSignal.aborted && !signal?.aborted) {
            throw new Error(`read timed out after ${config.toolTimeoutMs} ms`, { cause: error });
          }
          throw error;
        }
        const header = `[read ${target.relative}:${startLine}-${endLine}]`;
        const body = result.empty ? "<no lines in requested range>" : result.text;
        const suffix = result.truncated ? "\n<output truncated by byte limit>" : "";
        return {
          content: [{ type: "text", text: `${header}\n${body}${suffix}` }],
          details: { tool: "read", path: target.relative, ...result },
        };
      }, signal),
  };
  return tool;
}
