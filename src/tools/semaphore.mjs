export class Semaphore {
  #available;
  #queue = [];

  constructor(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Semaphore limit must be a positive integer.");
    this.#available = limit;
  }

  async acquire(signal) {
    if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted");
    if (this.#available > 0) {
      this.#available -= 1;
      return this.#releaseFactory();
    }
    return await new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, onAbort: null };
      entry.onAbort = () => {
        const index = this.#queue.indexOf(entry);
        if (index >= 0) this.#queue.splice(index, 1);
        reject(signal.reason ?? new Error("Operation aborted"));
      };
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      this.#queue.push(entry);
    });
  }

  #releaseFactory() {
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

  async run(fn, signal) {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
