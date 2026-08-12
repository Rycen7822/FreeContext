import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";

const PROVIDER_BUSY = /\b(?:service|server)[_ -]?busy\b|服务繁忙/iu;
const MAX_RETRY_DELAY_MS = 60000;

export interface ProviderRetryPolicy {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly shouldRetry?: (message: AssistantMessage) => boolean;
}

export interface ProviderRetryCallbacks {
  readonly onRetryScheduled?: (
    message: AssistantMessage,
    attempt: number,
    maxRetries: number,
    delayMs: number,
  ) => Promise<void> | void;
  readonly onRetryStart?: (attempt: number) => Promise<void> | void;
}

export function shouldRetryProviderMessage(message: AssistantMessage): boolean {
  return isRetryableAssistantError(message) || Boolean(message.errorMessage && PROVIDER_BUSY.test(message.errorMessage));
}

function providerRetryDelayMs(baseDelayMs: number, attempt: number): number {
  return Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), MAX_RETRY_DELAY_MS);
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

export async function retryProviderMessage(
  initial: AssistantMessage,
  retry: (failed: AssistantMessage) => Promise<AssistantMessage>,
  policy: ProviderRetryPolicy,
  signal?: AbortSignal,
  callbacks: ProviderRetryCallbacks = {},
): Promise<AssistantMessage> {
  let current = initial;
  for (let attempt = 1; attempt <= policy.maxRetries; attempt += 1) {
    if (!(policy.shouldRetry ?? shouldRetryProviderMessage)(current)) break;
    const delayMs = providerRetryDelayMs(policy.baseDelayMs, attempt);
    await callbacks.onRetryScheduled?.(current, attempt, policy.maxRetries, delayMs);
    if (!(await waitForProviderRetry(delayMs, signal)) || signal?.aborted) {
      const { errorMessage: _errorMessage, ...aborted } = current;
      return { ...aborted, stopReason: "aborted" };
    }
    await callbacks.onRetryStart?.(attempt);
    current = await retry(current);
  }
  return current;
}
