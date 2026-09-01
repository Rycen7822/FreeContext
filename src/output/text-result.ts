import type {
  FreeContextErrorCode,
  FreeContextInvocationContext,
  FreeContextRequest,
  FreeContextResult,
} from "../mcp/contracts.js";

export interface FreeContextTerminal {
  readonly errorCode: FreeContextErrorCode | null;
  readonly reason?: string;
}

/** Build the transport envelope around opaque worker text. */
export async function compileFreeContextResult(
  _request: Readonly<FreeContextRequest>,
  invocation: Readonly<FreeContextInvocationContext>,
  text: string,
  terminal: Readonly<FreeContextTerminal> = Object.freeze({ errorCode: null }),
): Promise<Readonly<FreeContextResult>> {
  const hasAnswer = text.trim().length > 0;
  return Object.freeze({
    status: terminal.errorCode
      ? hasAnswer ? "partial" : "failed"
      : hasAnswer ? "complete" : "partial",
    text: hasAnswer ? text : terminal.reason || "No answer was returned.",
    errorCode: terminal.errorCode,
    sessionId: invocation.sessionId,
    sessionFile: invocation.sessionFile,
  });
}
