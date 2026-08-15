import { FreeContextError, SessionPersistenceError } from "../errors.js";
import { compileFreeContextResult } from "../output/evidence.js";
import type { ContextTokenCounter } from "../runtime/context-budget.js";
import { extractAssistantText } from "../runtime/pi-session.js";
import type { FreeContextRuntimeEvent } from "../runtime/pi-session.js";
import { runExplorer } from "../runtime/run.js";
import { captureError, captureRuntimeEvent } from "../runtime/session-capture.js";
import type { ExplorerCapturedError, ExplorerSessionCapture } from "../runtime/session-capture.js";
import type {
  FreeContextErrorCode,
  FreeContextCallContext,
  FreeContextRequest,
  FreeContextResult,
} from "./contracts.js";
import { serializeForModel } from "./contracts.js";
import { classifyExplorerError, errorReason, failedResult } from "./failure.js";
import { lateDiagnosticFileFor } from "./lifecycle.js";
import type { DeadlineClock, TerminalDecision, TerminalStore, TerminalWinner } from "./lifecycle.js";
import type { McpRuntimeEvent } from "./session.js";
import { cancelMcpSession, commitMcpSession, reserveMcpSession } from "./session.js";

const NEVER = new Promise<never>(() => undefined);

export interface SingleCallDependencies {
  readonly tokenCounter: ContextTokenCounter;
  readonly terminalStore: TerminalStore;
  readonly deadlineClock: DeadlineClock;
  readonly deadlineMs: number;
  readonly sessionDirectory?: string;
  readonly sessionFile?: string;
  readonly configFile?: string;
  readonly runExplorer?: typeof runExplorer;
  readonly compileResult?: typeof compileFreeContextResult;
  readonly reserveSession?: typeof reserveMcpSession;
  readonly cancelSession?: typeof cancelMcpSession;
  readonly commitSession?: typeof commitMcpSession;
  readonly now?: () => Date;
}

export interface SingleCallExecution {
  readonly result: Readonly<FreeContextResult>;
  readonly serializedText: string;
  readonly meta: Readonly<Record<string, unknown>>;
}

interface TerminalOutcome {
  readonly result: Readonly<FreeContextResult>;
  readonly terminalError: Readonly<ExplorerCapturedError> | null;
  readonly decision: Readonly<TerminalDecision>;
}

function createAbortGate(signal: AbortSignal): Readonly<{ promise: Promise<void>; dispose: () => void }> {
  let listener: (() => void) | null = null;
  const promise = signal.aborted
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        listener = () => resolve();
        signal.addEventListener("abort", listener, { once: true });
      });
  return Object.freeze({
    promise,
    dispose: () => {
      if (listener) signal.removeEventListener("abort", listener);
    },
  });
}

function latestCandidateFromEvent(event: FreeContextRuntimeEvent): string {
  if (event.type === "message_update") return extractAssistantText(event.message);
  if (event.type === "turn_end") return extractAssistantText(event.message);
  return "";
}

function captureBytes(capture: Readonly<ExplorerSessionCapture> | null): number {
  return capture ? Buffer.byteLength(JSON.stringify(capture)) : 0;
}

function execution(
  result: Readonly<FreeContextResult>,
  meta: Readonly<Record<string, unknown>>,
): Readonly<SingleCallExecution> {
  return Object.freeze({ result, serializedText: serializeForModel(result), meta });
}

export async function executeSingleCall(
  request: Readonly<FreeContextRequest>,
  callContext: Readonly<FreeContextCallContext>,
  externalSignal: AbortSignal | undefined,
  dependencies: Readonly<SingleCallDependencies>,
): Promise<Readonly<SingleCallExecution>> {
  const explore = dependencies.runExplorer ?? runExplorer;
  const compile = dependencies.compileResult ?? compileFreeContextResult;
  const reserve = dependencies.reserveSession ?? reserveMcpSession;
  const cancel = dependencies.cancelSession ?? cancelMcpSession;
  const commit = dependencies.commitSession ?? commitMcpSession;
  const now = dependencies.now ?? (() => new Date());
  const deadline = dependencies.deadlineClock.start(dependencies.deadlineMs);
  const operationSignal = externalSignal
    ? AbortSignal.any([externalSignal, deadline.signal])
    : deadline.signal;
  const abortGate = createAbortGate(operationSignal);
  const terminalWinner = (): TerminalWinner => deadline.didExpire() ? "deadline" : "abort";

  try {
    const reservationPromise = reserve({
      request,
      ...callContext,
      ...(dependencies.sessionDirectory ? { sessionDirectory: dependencies.sessionDirectory } : {}),
      ...(dependencies.sessionFile ? { sessionFile: dependencies.sessionFile } : {}),
      now,
    });
    const reservationOutcome = await Promise.race([
      reservationPromise.then(
        (reservation) => ({ kind: "reservation" as const, reservation }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      abortGate.promise.then(() => ({ kind: "abort" as const })),
    ]);
    if (reservationOutcome.kind === "abort") {
      const winner = terminalWinner();
      dependencies.terminalStore.tryClaim({
        invocationId: callContext.invocationId,
        winner,
        decidedAt: now().toISOString(),
        lateDiagnosticFile: null,
      });
      void reservationPromise.then((reservation) => cancel(reservation)).catch(() => undefined);
      return execution(failedResult({
        code: "DEADLINE_EXCEEDED",
        reason: errorReason("DEADLINE_EXCEEDED"),
        sessionId: callContext.invocationId,
        sessionFile: null,
        request,
      }), { terminalWinner: winner, deadlineMs: dependencies.deadlineMs });
    }
    if (reservationOutcome.kind === "error") {
      dependencies.terminalStore.tryClaim({
        invocationId: callContext.invocationId,
        winner: "setup",
        decidedAt: now().toISOString(),
        lateDiagnosticFile: null,
      });
      return execution(failedResult({
        code: "SESSION_PERSISTENCE_FAILED",
        reason: errorReason("SESSION_PERSISTENCE_FAILED"),
        sessionId: callContext.invocationId,
        sessionFile: null,
        request,
      }), {});
    }

    const reservation = reservationOutcome.reservation;
    const lateDiagnosticFile = lateDiagnosticFileFor(reservation.invocation.sessionFile);
    const runtimeEvents: McpRuntimeEvent[] = [];
    let capture: Readonly<ExplorerSessionCapture> | null = null;
    let latestCandidate = "";
    let resolveAbortClaim: () => void = () => {};
    const abortClaimed = new Promise<void>((resolve) => { resolveAbortClaim = resolve; });

    const recordLate = async (
      settlement: Parameters<TerminalStore["recordLate"]>[0]["settlement"],
    ): Promise<never> => {
      await dependencies.terminalStore.recordLate({
        invocation: reservation.invocation,
        settlement,
        settledAt: now().toISOString(),
      }).catch(() => undefined);
      return NEVER;
    };

    const workerOutcome: Promise<TerminalOutcome> = (async () => {
      let result: Readonly<FreeContextResult>;
      let terminalError: Readonly<ExplorerCapturedError> | null = null;
      let settlement: Parameters<TerminalStore["recordLate"]>[0]["settlement"];
      try {
        const explored = await explore({
          request,
          invocation: reservation.invocation,
          ...(dependencies.configFile ? { cli: { configFile: dependencies.configFile } } : {}),
          signal: operationSignal,
          onEvent: (event, state) => {
            const candidate = latestCandidateFromEvent(event);
            if (candidate) latestCandidate = candidate;
            runtimeEvents.push(Object.freeze({
              event: captureRuntimeEvent(event),
              state: Object.freeze({ ...state }),
            }));
          },
          onSessionCapture: (value) => { capture = value; },
          dependencies: { tokenCounter: dependencies.tokenCounter },
        });
        if (
          explored.sessionId !== reservation.invocation.sessionId ||
          explored.sessionFile !== reservation.invocation.sessionFile
        ) throw new Error("Explorer result identity did not match the reserved invocation.");
        result = explored;
        settlement = { kind: "result", result };
      } catch (error) {
        terminalError = captureError(error);
        const code = classifyExplorerError(error, operationSignal);
        result = failedResult({
          code,
          reason: errorReason(code),
          sessionId: reservation.invocation.sessionId,
          sessionFile: reservation.invocation.sessionFile,
          request,
        });
        settlement = { kind: "error", error };
      }
      if (operationSignal.aborted) {
        await abortClaimed;
        return recordLate(settlement);
      }
      const decision = dependencies.terminalStore.tryClaim({
        invocationId: reservation.invocation.invocationId,
        winner: "worker",
        decidedAt: now().toISOString(),
        lateDiagnosticFile: null,
      });
      return decision ? { result, terminalError, decision } : recordLate(settlement);
    })();

    const abortOutcome: Promise<TerminalOutcome> = abortGate.promise.then(async () => {
      const winner = terminalWinner();
      const decision = dependencies.terminalStore.tryClaim({
        invocationId: reservation.invocation.invocationId,
        winner,
        decidedAt: now().toISOString(),
        lateDiagnosticFile,
      });
      resolveAbortClaim();
      if (!decision) return workerOutcome;
      const code: FreeContextErrorCode = "DEADLINE_EXCEEDED";
      const terminalError = captureError(new FreeContextError(errorReason(code), { code }));
      let result: Readonly<FreeContextResult>;
      try {
        result = await compile(request, reservation.invocation, latestCandidate, {
          errorCode: code,
          reason: errorReason(code),
        });
      } catch {
        result = failedResult({
          code,
          reason: errorReason(code),
          sessionId: reservation.invocation.sessionId,
          sessionFile: reservation.invocation.sessionFile,
          request,
        });
      }
      return { result, terminalError, decision };
    });

    const outcome = await Promise.race([workerOutcome, abortOutcome]);
    const serializedText = serializeForModel(outcome.result);
    let committed;
    try {
      committed = await commit({
        reservation,
        capture,
        runtimeEvents,
        result: outcome.result,
        serializedText,
        terminalDecision: outcome.decision,
        terminalError: outcome.terminalError,
        now,
      });
      if (committed.sessionFile !== reservation.invocation.sessionFile) {
        throw new SessionPersistenceError("close");
      }
    } catch (error) {
      const persistenceStage = error instanceof SessionPersistenceError ? error.stage : "unknown";
      return execution(failedResult({
        code: "SESSION_PERSISTENCE_FAILED",
        reason: errorReason("SESSION_PERSISTENCE_FAILED"),
        sessionId: reservation.invocation.sessionId,
        sessionFile: null,
        request,
      }), { persistenceStage });
    }

    const sessionCapture = capture as Readonly<ExplorerSessionCapture> | null;
    return Object.freeze({
      result: outcome.result,
      serializedText,
      meta: Object.freeze({
        metrics: sessionCapture?.metrics ?? null,
        compilerProblems: sessionCapture?.compiler.problems ?? [],
        captureBytes: captureBytes(sessionCapture),
        sessionBytes: committed.sessionBytes,
        sessionFileSha256: committed.sessionFileSha256,
        terminalWinner: outcome.decision.winner,
        lateDiagnosticFile: outcome.decision.lateDiagnosticFile,
      }),
    });
  } finally {
    abortGate.dispose();
    deadline.dispose();
  }
}
