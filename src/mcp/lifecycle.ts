import path from "node:path";
import type { FreeContextInvocationContext, FreeContextResult } from "./contracts.js";
import { captureError } from "../runtime/session-capture.js";
import { commitSessionFile, reserveSessionFile } from "../session/store.js";

export const SINGLE_CALL_DEADLINE_MS = 285_000;

export interface DeadlineLease {
  readonly signal: AbortSignal;
  readonly didExpire: () => boolean;
  readonly dispose: () => void;
}

export interface DeadlineClock {
  start(durationMs: number): Readonly<DeadlineLease>;
}

export function createDeadlineClock(): DeadlineClock {
  return Object.freeze({
    start(durationMs: number): Readonly<DeadlineLease> {
      const controller = new AbortController();
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        controller.abort(new Error(`FreeContext deadline exceeded after ${durationMs} ms.`));
      }, durationMs);
      timer.unref?.();
      return Object.freeze({
        signal: controller.signal,
        didExpire: () => expired,
        dispose: () => clearTimeout(timer),
      });
    },
  });
}

export type TerminalWinner = "worker" | "deadline" | "abort" | "setup";

export interface TerminalDecision {
  readonly invocationId: string;
  readonly winner: TerminalWinner;
  readonly decidedAt: string;
  readonly lateResultExpected: boolean;
  readonly lateDiagnosticFile: string | null;
}

export type LateWorkerSettlement =
  | Readonly<{ kind: "result"; result: Readonly<FreeContextResult> }>
  | Readonly<{ kind: "error"; error: unknown }>;

export interface TerminalStore {
  tryClaim(input: Readonly<{
    invocationId: string;
    winner: TerminalWinner;
    decidedAt: string;
    lateDiagnosticFile: string | null;
  }>): Readonly<TerminalDecision> | null;
  recordLate(input: Readonly<{
    invocation: Readonly<FreeContextInvocationContext>;
    settlement: LateWorkerSettlement;
    settledAt: string;
  }>): Promise<void>;
}

export function lateDiagnosticFileFor(sessionFile: string): string {
  return `${sessionFile.slice(0, -path.extname(sessionFile).length)}.late.json`;
}

export function createTerminalStore(): TerminalStore {
  const decisions = new Map<string, Readonly<TerminalDecision>>();
  return Object.freeze({
    tryClaim(input: Parameters<TerminalStore["tryClaim"]>[0]): Readonly<TerminalDecision> | null {
      if (decisions.has(input.invocationId)) return null;
      const decision = Object.freeze({
        ...input,
        lateResultExpected: input.winner === "deadline" || input.winner === "abort",
      });
      decisions.set(input.invocationId, decision);
      return decision;
    },
    async recordLate({ invocation, settlement, settledAt }: Parameters<TerminalStore["recordLate"]>[0]): Promise<void> {
      const decision = decisions.get(invocation.invocationId);
      if (!decision?.lateResultExpected || !decision.lateDiagnosticFile) return;
      const reservation = await reserveSessionFile({
        workspaceRoot: invocation.workspaceRoot,
        filePath: decision.lateDiagnosticFile,
      });
      await commitSessionFile(reservation, {
        schemaVersion: "freecontext-late-result-v2",
        invocation,
        terminalDecision: decision,
        settledAt,
        settlement: settlement.kind === "result"
          ? { kind: "result", result: settlement.result }
          : { kind: "error", error: captureError(settlement.error) },
      });
    },
  });
}
