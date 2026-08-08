type Release = () => void;

interface QueueEntry {
  readonly resolve: (release: Release) => void;
  readonly reject: (reason?: unknown) => void;
  readonly signal: AbortSignal | undefined;
  onAbort: () => void;
}

export class Semaphore {
  #available: number;
  readonly #queue: QueueEntry[] = [];

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Semaphore limit must be a positive integer.");
    this.#available = limit;
  }

  async acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted");
    if (this.#available > 0) {
      this.#available -= 1;
      return this.#releaseFactory();
    }
    return await new Promise<Release>((resolve, reject) => {
      const entry: QueueEntry = { resolve, reject, signal, onAbort: () => undefined };
      entry.onAbort = () => {
        const index = this.#queue.indexOf(entry);
        if (index >= 0) this.#queue.splice(index, 1);
        reject(signal?.reason ?? new Error("Operation aborted"));
      };
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      this.#queue.push(entry);
    });
  }

  #releaseFactory(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#queue.shift();
      if (next) {
        next.signal?.removeEventListener("abort", next.onAbort);
        next.resolve(this.#releaseFactory());
      } else {
        this.#available += 1;
      }
    };
  }

  async run<T>(fn: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
