import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { runCommand, sanitizedToolEnv } from "../src/tools/process.mjs";

test("a pre-aborted command is killed without waiting for its normal lifetime", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled before spawn"));
  const started = Date.now();
  const result = await runCommand({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 10000)"],
    cwd: os.tmpdir(),
    signal: controller.signal,
    timeoutMs: 10000,
    maxOutputBytes: 4096,
    env: sanitizedToolEnv(),
  });
  assert.ok(Date.now() - started < 2000, "pre-aborted process should terminate promptly");
  assert.ok(result.signal || result.code !== 0);
  assert.equal(result.timedOut, false);
});
