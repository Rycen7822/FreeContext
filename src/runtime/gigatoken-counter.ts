import { fileURLToPath } from "node:url";
import { ConfigurationError } from "../errors.js";
import { spawnGigatokenWorker, type GigatokenWorkerProcess } from "../tools/process.js";

export interface TextTokenCounter {
  count(text: string): Promise<number>;
  countBatch(texts: readonly string[]): Promise<readonly number[]>;
  close(): Promise<void>;
}

interface PendingRequest {
  readonly resolve: (counts: readonly number[]) => void;
  readonly reject: (error: Error) => void;
}

interface WorkerResponse {
  readonly id: number | null;
  readonly counts?: readonly number[];
  readonly error?: string;
}

const DEFAULT_WORKER = fileURLToPath(new URL("../../bin/gigatoken-worker.py", import.meta.url));

export class GigatokenCounter implements TextTokenCounter {
  readonly #child: GigatokenWorkerProcess;
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #stdout = "";
  #stderr = "";
  #closed = false;
  #failure: Error | null = null;

  constructor({
    python = process.env.FREECONTEXT_PYTHON ?? "python3",
    worker = DEFAULT_WORKER,
  }: {
    readonly python?: string;
    readonly worker?: string;
  } = {}) {
    this.#child = spawnGigatokenWorker(python, worker);
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#consume(chunk));
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-4_096);
    });
    this.#child.on("error", (error) => this.#fail(error));
    this.#child.on("exit", (code) => {
      if (!this.#closed) {
        this.#fail(
          new ConfigurationError(
            `Gigatoken worker exited with code ${code ?? "unknown"}. Install Python packages with ` +
              "`python3 -m pip install gigatoken tiktoken`." +
              (this.#stderr.trim() ? ` ${this.#stderr.trim()}` : ""),
          ),
        );
      }
    });
  }

  async count(text: string): Promise<number> {
    const [count] = await this.countBatch([text]);
    if (count === undefined) throw new ConfigurationError("Gigatoken returned no count for a single text.");
    return count;
  }

  async countBatch(texts: readonly string[]): Promise<readonly number[]> {
    if (texts.length === 0) return Object.freeze([]);
    if (this.#closed) throw new ConfigurationError("Gigatoken counter is closed.");
    if (this.#failure) throw this.#failure;
    const id = this.#nextId++;
    const result = new Promise<readonly number[]>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#child.stdin.write(`${JSON.stringify({ id, texts })}\n`);
    return result;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.stdin.end();
    if (this.#child.exitCode !== null) return;
    await new Promise<void>((resolve) => this.#child.once("exit", () => resolve()));
  }

  #consume(chunk: string): void {
    this.#stdout += chunk;
    for (;;) {
      const newline = this.#stdout.indexOf("\n");
      if (newline < 0) return;
      const line = this.#stdout.slice(0, newline);
      this.#stdout = this.#stdout.slice(newline + 1);
      if (!line) continue;
      let response: WorkerResponse;
      try {
        response = JSON.parse(line) as WorkerResponse;
      } catch (error) {
        this.#fail(new ConfigurationError("Gigatoken worker returned invalid JSON.", { cause: error }));
        return;
      }
      if (response.id === null) {
        this.#fail(new ConfigurationError(response.error ?? "Gigatoken worker rejected a request."));
        return;
      }
      const pending = this.#pending.get(response.id);
      if (!pending) continue;
      this.#pending.delete(response.id);
      if (response.error) pending.reject(new ConfigurationError(`Gigatoken worker failed: ${response.error}`));
      else if (!response.counts?.every((count) => Number.isSafeInteger(count) && count >= 0)) {
        pending.reject(new ConfigurationError("Gigatoken worker returned invalid token counts."));
      }
      else pending.resolve(Object.freeze([...response.counts]));
    }
  }

  #fail(error: Error): void {
    this.#failure = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
