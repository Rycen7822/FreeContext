import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BenchmarkMasterAgentContext } from "../src/benchmark/master-context.js";
import { exportMasterAgentContext } from "../src/benchmark/master-context.js";

const RUNTIME_SESSION = "/logs/agent/freecontext-sessions/call-001.json";

function freeContextSession() {
  return {
    schemaVersion: "freecontext-benchmark-session-v1",
    capturedAt: "2026-08-09T00:00:00.000Z",
    invocation: {
      request: "locate the router",
      cwd: "/workspace",
      cliOutput: "<final_answer>\nsummary: router found\nevidence:\n- src/router.ts:1-2 — route\ngaps:\n- none\n</final_answer>\n",
    },
    capture: {
      schemaVersion: "freecontext-session-v1",
      request: "locate the router",
      runtime: { workspace: "/workspace" },
      primary: { output: "raw model answer" },
      primaryValidation: { valid: true },
      repair: null,
      outcome: {
        status: "completed",
        answer: "<final_answer>\nsummary: router found\nevidence:\n- src/router.ts:1-2 — route\ngaps:\n- none\n</final_answer>",
      },
    },
    runtimeEvents: [],
    terminalError: null,
  };
}

async function createFixture(root: string, includeReference: boolean): Promise<Readonly<{
  agentDir: string;
  masterRaw: string;
  sessionRaw: string;
}>> {
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(agentDir, "sessions", "2026", "08", "09");
  const freeContextDir = path.join(agentDir, "freecontext-sessions");
  await Promise.all([
    mkdir(sessionDir, { recursive: true }),
    mkdir(freeContextDir, { recursive: true }),
  ]);
  const masterRaw = [
    JSON.stringify({ type: "other_context", payload: "before" }),
    JSON.stringify({
      type: "freecontext_tool_output",
      payload: includeReference ? `compact output\n\nFreeContext full session: ${RUNTIME_SESSION}` : "compact output",
    }),
    JSON.stringify({ type: "other_context", payload: "after" }),
  ].join("\n") + "\n";
  const sessionRaw = `${JSON.stringify(freeContextSession(), null, 2)}\n`;
  await Promise.all([
    writeFile(path.join(sessionDir, "rollout.jsonl"), masterRaw, "utf8"),
    writeFile(path.join(freeContextDir, "call-001.json"), sessionRaw, "utf8"),
  ]);
  return { agentDir, masterRaw, sessionRaw };
}

test("master context exporter preserves all master events and references separate FreeContext raw sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-master-"));
  try {
    const fixture = await createFixture(root, true);
    const outputPath = await exportMasterAgentContext({
      agentDir: fixture.agentDir,
      taskName: "TaskNameXXX",
      now: () => new Date("2026-08-09T01:00:00.000Z"),
    });
    const document = JSON.parse(await readFile(outputPath, "utf8")) as BenchmarkMasterAgentContext;

    assert.equal(document.taskName, "TaskNameXXX");
    assert.equal(document.masterAgentContext[0]?.rawJsonl, fixture.masterRaw);
    assert.equal(document.freeContextCalls[0]?.promptToFreeContext, "locate the router");
    assert.equal(
      document.freeContextCalls[0]?.outputToMasterAgent,
      `${freeContextSession().invocation.cliOutput.trimEnd()}\n\nFreeContext full session: ${RUNTIME_SESSION}`,
    );
    assert.equal(document.freeContextCalls[0]?.fullSessionFile, "freecontext-sessions/call-001.json");
    assert.equal(document.freeContextCalls[0]?.runtimeSessionFile, RUNTIME_SESSION);
    assert.equal(document.freeContextCalls[0]?.referenceFoundInMasterContext, true);
    assert.equal(
      await readFile(path.join(fixture.agentDir, "freecontext-sessions", "call-001.json"), "utf8"),
      fixture.sessionRaw,
    );
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("master context exporter fails when the master context omits a FreeContext session reference", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-master-"));
  try {
    const fixture = await createFixture(root, false);
    await assert.rejects(
      exportMasterAgentContext({ agentDir: fixture.agentDir, taskName: "TaskNameXXX" }),
      /does not reference/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical Pier adapter wires per-call capture and post-run master export", async () => {
  const source = await readFile(
    new URL("../benchmarks/deepswe/pier_codex_freecontext_agent.py", import.meta.url),
    "utf8",
  );
  assert.match(source, /--benchmark-session-file/u);
  assert.match(source, /FreeContext full session: %s/u);
  assert.match(source, /freecontext-benchmark-context\.mjs/u);
  assert.match(source, /benchmarks\/deepswe\/freecontext\.toml/u);
});
