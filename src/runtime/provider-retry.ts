import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ProviderFailureSignal } from "./provider-failure.js";

const DEFAULT_JITTER_RATIO = 0.2;

export interface ProviderAttempt {
  readonly message: AssistantMessage;
  readonly failure: Readonly<ProviderFailureSignal> | null;
}

export interface ProviderRetryPolicy {
  readonly delaysMs: readonly number[];
  readonly random?: () => number;
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<boolean>;
}

export interface ProviderRetrySchedule {
  readonly failedMessage: AssistantMessage;
  readonly failure: Readonly<ProviderFailureSignal>;
  readonly attempt: number;
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly delayMs: number;
}

export interface ProviderFailureObservation {
  readonly failedMessage: AssistantMessage;
  readonly failure: Readonly<ProviderFailureSignal>;
  readonly attempt: number;
  readonly willRetry: boolean;
}

export interface ProviderRetryCallbacks {
  readonly onFailure?: (observation: Readonly<ProviderFailureObservation>) => Promise<void> | void;
  readonly onRetryScheduled?: (schedule: Readonly<ProviderRetrySchedule>) => Promise<void> | void;
  readonly onRetryStart?: (schedule: Readonly<ProviderRetrySchedule>) => Promise<void> | void;
}

function jitteredDelayMs(baseDelayMs: number, random: () => number): number {
  const centered = Math.max(0, Math.min(1, random())) * 2 - 1;
  return Math.max(0, Math.round(baseDelayMs * (1 + centered * DEFAULT_JITTER_RATIO)));
}

async function waitForProviderRetry(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortedAttempt(current: Readonly<ProviderAttempt>): ProviderAttempt {
  const { errorMessage: _errorMessage, ...aborted } = current.message;
  return { message: { ...aborted, stopReason: "aborted" }, failure: null };
}

export async function retryProviderMessage(
  initial: Readonly<ProviderAttempt>,
  retry: (failed: Readonly<ProviderAttempt>) => Promise<ProviderAttempt>,
  policy: Readonly<ProviderRetryPolicy>,
  signal?: AbortSignal,
  callbacks: Readonly<ProviderRetryCallbacks> = {},
): Promise<ProviderAttempt> {
  let current = initial;
  const random = policy.random ?? Math.random;
  const sleep = policy.sleep ?? waitForProviderRetry;
  let attempt = 1;
  for (let index = 0; ; index += 1) {
    const failure = current.failure;
    if (!failure) break;
    const willRetry = failure.retryable && index < policy.delaysMs.length;
    await callbacks.onFailure?.({ failedMessage: current.message, failure, attempt, willRetry });
    if (!willRetry) break;
    const baseDelayMs = policy.delaysMs[index] ?? 0;
    const schedule: ProviderRetrySchedule = {
      failedMessage: current.message,
      failure,
      attempt: index + 1,
      maxRetries: policy.delaysMs.length,
      baseDelayMs,
      delayMs: jitteredDelayMs(baseDelayMs, random),
    };
    await callbacks.onRetryScheduled?.(schedule);
    if (!(await sleep(schedule.delayMs, signal)) || signal?.aborted) return abortedAttempt(current);
    await callbacks.onRetryStart?.(schedule);
    current = await retry(current);
    attempt += 1;
  }
  return current;
}
