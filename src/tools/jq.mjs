import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand, sanitizedToolEnv } from "./process.mjs";
import { assertDirectFileSize } from "./workspace.mjs";

const EMPTY_LIBRARY = path.join(path.dirname(fileURLToPath(import.meta.url)), "empty-jq-lib");

export function createJqTool({ Type, workspace, semaphore, config, executable }) {
  return {
    name: "jq",
    label: "Query JSON file",
    description:
      "Run a jq filter against one JSON file inside the repository. Module loading is disabled and the subprocess receives a scrubbed environment. Read-only.",
    parameters: Type.Object({
      path: Type.String({ description: "Repository-relative JSON file path." }),
      filter: Type.String({ minLength: 1, maxLength: 4000, description: "jq filter expression." }),
      compact: Type.Optional(Type.Boolean({ description: "Emit compact JSON." })),
      raw: Type.Optional(Type.Boolean({ description: "Emit raw strings." })),
    }),
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal) =>
      await semaphore.run(async () => {
        const target = await workspace.resolveExisting(params.path, { kind: "file" });
        assertDirectFileSize(target);
        const args = ["--monochrome-output", "-L", EMPTY_LIBRARY];
        if (params.compact) args.push("--compact-output");
        if (params.raw) args.push("--raw-output");
        // End jq option parsing before the model-controlled filter. Without this
        // separator a filter such as "--version" would be interpreted as a jq
        // CLI flag instead of data, bypassing the intended single-file query.
        args.push("--", params.filter, target.absolute);
        const result = await runCommand({
          command: executable,
          args,
          cwd: workspace.root,
          signal,
          timeoutMs: config.toolTimeoutMs,
          maxOutputBytes: config.maxToolOutputBytes,
          env: sanitizedToolEnv({ JQ_LIBRARY_PATH: EMPTY_LIBRARY }),
        });
        if (result.timedOut) throw new Error(`jq timed out after ${config.toolTimeoutMs} ms`);
        if (result.code !== 0) {
          throw new Error(`jq failed with exit code ${result.code}: ${result.stderr.trim() || "invalid JSON/filter"}`);
        }
        const body = result.stdout.trimEnd() || "<empty jq output>";
        return {
          content: [
            {
              type: "text",
              text: `[jq path=${target.relative} filter=${JSON.stringify(params.filter)}]\n${body}${result.truncated ? "\n<output truncated>" : ""}`,
            },
          ],
          details: { tool: "jq", path: target.relative, filter: params.filter, truncated: result.truncated },
        };
      }, signal),
  };
}
