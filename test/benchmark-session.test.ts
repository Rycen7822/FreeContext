import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeBenchmarkSessionFile } from "../src/benchmark/session-file.js";
import { SecurityError } from "../src/errors.js";

test("benchmark session writer creates a private non-overwriting file outside the workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-session-"));
  const workspace = path.join(root, "workspace");
  const logs = path.join(root, "logs");
  const target = path.join(logs, "session.json");
  try {
    await Promise.all([mkdir(workspace), mkdir(logs, { mode: 0o700 })]);
    const options = {
      filePath: target,
      workspaceRoot: workspace,
      request: "find a",
      cwd: workspace,
      cliOutput: "freecontext: PROVIDER_ERROR: unavailable\n",
      capture: null,
      runtimeEvents: [
        { event: { type: "turn_start" as const }, state: { turnCount: 0, toolCallCount: 0, providerAttempts: 1 } },
      ],
      terminalError: { name: "ProviderError", code: "PROVIDER_ERROR", message: "unavailable" },
      now: () => new Date("2026-08-09T00:00:00.000Z"),
    } as const;

    assert.equal(await writeBenchmarkSessionFile(options), target);
    const document: unknown = JSON.parse(await readFile(target, "utf8"));
    assert.deepEqual(document, {
      schemaVersion: "freecontext-benchmark-session-v1",
      capturedAt: "2026-08-09T00:00:00.000Z",
      invocation: {
        request: "find a",
        cwd: workspace,
        cliOutput: "freecontext: PROVIDER_ERROR: unavailable\n",
      },
      capture: null,
      runtimeEvents: [
        {
          event: { type: "turn_start" },
          state: { turnCount: 0, toolCallCount: 0, providerAttempts: 1 },
        },
      ],
      terminalError: { name: "ProviderError", code: "PROVIDER_ERROR", message: "unavailable" },
    });
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    await assert.rejects(writeBenchmarkSessionFile(options), /EEXIST/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("benchmark session writer rejects paths inside the explored workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-session-"));
  const workspace = path.join(root, "workspace");
  try {
    await mkdir(workspace);
    const writeInside = (filePath: string) => writeBenchmarkSessionFile({
        filePath,
        workspaceRoot: workspace,
        request: "find a",
        cwd: workspace,
        cliOutput: "",
        capture: null,
        runtimeEvents: [],
        terminalError: null,
      });
    await assert.rejects(
      writeInside(path.join(workspace, "session.json")),
      (error: unknown) => error instanceof SecurityError,
    );
    const linkedLogs = path.join(root, "linked-logs");
    await symlink(workspace, linkedLogs, "dir");
    await assert.rejects(
      writeInside(path.join(linkedLogs, "session.json")),
      (error: unknown) => error instanceof SecurityError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
