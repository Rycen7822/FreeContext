import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ProcessOptions, ProcessResult } from "./contracts.js";

const DEFAULT_PATH = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";

export type GigatokenWorkerProcess = ChildProcessWithoutNullStreams;

export function spawnGigatokenWorker(python: string, worker: string): GigatokenWorkerProcess {
  if (!path.isAbsolute(worker)) throw new Error(`Gigatoken worker path must be absolute: ${worker}`);
  return spawn(python, [worker], {
    env: sanitizedToolEnv(),
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function sanitizedToolEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: DEFAULT_PATH,
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL || "C.UTF-8",
    HOME: os.tmpdir(),
    NO_COLOR: "1",
    PAGER: "cat",
    GIT_PAGER: "cat",
    BAT_PAGER: "cat",
    BAT_CONFIG_PATH: process.platform === "win32" ? "NUL" : "/dev/null",
    ...extra,
  };
}

export async function findExecutable(names: string | readonly string[], envPath = DEFAULT_PATH): Promise<string | null> {
  const candidates = Array.isArray(names) ? names : [names];
  const suffixes = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const directory of envPath.split(path.delimiter)) {
    if (!directory) continue;
    for (const name of candidates) {
      for (const suffix of suffixes) {
        const candidate = path.join(directory, process.platform === "win32" ? `${name}${suffix}` : name);
        try {
          await access(candidate, fsConstants.X_OK);
          return candidate;
        } catch {
          // Continue searching.
        }
      }
    }
  }
  return null;
}

function combineAbortSignals(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Command timed out after ${timeoutMs} ms`));
  }, timeoutMs);
  timeout.unref?.();
  const onAbort = () => controller.abort(signal?.reason ?? new Error("Operation aborted"));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export async function runCommand({
  command,
  args,
  cwd,
  signal,
  timeoutMs = 20000,
  maxOutputBytes = 65536,
  env = sanitizedToolEnv(),
}: ProcessOptions): Promise<ProcessResult> {
  if (!path.isAbsolute(command)) throw new Error(`Executable must be resolved to an absolute path: ${command}`);
  const combined = combineAbortSignals(signal, timeoutMs);

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let settled = false;

    const append = (
      target: Buffer[],
      chunk: Buffer,
      currentBytes: number,
      setter: (value: number) => void,
    ): void => {
      if (currentBytes >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = maxOutputBytes - currentBytes;
      const retained = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      target.push(retained);
      setter(currentBytes + retained.length);
      if (retained.length < chunk.length) truncated = true;
    };

    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk, stdoutBytes, (value) => { stdoutBytes = value; }));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk, stderrBytes, (value) => { stderrBytes = value; }));

    const onAbort = () => {
      if (!child.killed) child.kill("SIGKILL");
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      combined.signal.removeEventListener("abort", onAbort);
      combined.cleanup();
      reject(error);
    });

    child.on("close", (code, closeSignal) => {
      if (settled) return;
      settled = true;
      combined.signal.removeEventListener("abort", onAbort);
      combined.cleanup();
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      resolve({
        code,
        signal: closeSignal,
        stdout: stdoutText,
        stderr: stderrText,
        truncated,
        timedOut: combined.didTimeout(),
      });
    });

    if (combined.signal.aborted) onAbort();
    else combined.signal.addEventListener("abort", onAbort, { once: true });
  });
}
