import type {
  FreeContextErrorCode,
  FreeContextInvocationContext,
  FreeContextRequest,
  FreeContextResult,
} from "../mcp/contracts.js";

export interface FreeContextTerminal {
  readonly errorCode: FreeContextErrorCode | null;
  readonly reason?: string;
  readonly completed?: boolean;
}

/** Copy only explicit shallow capture metadata; never interpret log/source strings. */
function capturedExecutionMetadata(output: string): string {
  let capture: unknown;
  try { capture = JSON.parse(output); } catch { return ""; }
  const fields = new Set(["exit_code", "exitCode", "status", "session_id", "sessionId", "timed_out", "timedOut", "timeout", "cancelled", "canceled", "truncated", "is_truncated"]);
  const lines: string[] = [];
  const collect = (value: unknown, location: string): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (fields.has(key) && (item === null || ["string", "number", "boolean"].includes(typeof item))) {
        lines.push(`${location}[${JSON.stringify(key)}] = ${JSON.stringify(item)}`);
      }
    }
  };
  const roots = Array.isArray(capture) ? capture : [capture];
  for (const [index, root] of roots.entries()) {
    const location = Array.isArray(capture) ? `$[${index}]` : "$";
    collect(root, location);
    if (!root || typeof root !== "object" || Array.isArray(root)) continue;
    for (const [key, value] of Object.entries(root)) {
      // Output and payload data may contain source-shaped status fields, not execution facts.
      if (["output", "stdout", "stderr", "log", "logs", "payload"].includes(key)) continue;
      const childLocation = `${location}[${JSON.stringify(key)}]`;
      if (Array.isArray(value)) value.forEach((item, childIndex) => collect(item, `${childLocation}[${childIndex}]`));
      else collect(value, childLocation);
    }
  }
  return lines.length ? `\n\nCaptured execution metadata (supplied JSON paths and values):\n${lines.join("\n")}` : "";
}

/** Build the transport envelope around opaque worker text. */
export async function compileFreeContextResult(
  request: Readonly<FreeContextRequest>,
  invocation: Readonly<FreeContextInvocationContext>,
  text: string,
  terminal: Readonly<FreeContextTerminal> = Object.freeze({ errorCode: null }),
): Promise<Readonly<FreeContextResult>> {
  const hasAnswer = text.trim().length > 0;
  return Object.freeze({
    status: terminal.errorCode
      ? hasAnswer ? "partial" : "failed"
      : hasAnswer && terminal.completed !== false ? "complete" : "partial",
    text: (hasAnswer ? text : terminal.reason || "No answer was returned.") + capturedExecutionMetadata(request.output),
    errorCode: terminal.errorCode,
    sessionId: invocation.sessionId,
    sessionFile: invocation.sessionFile,
  });
}
