import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FreeContextCallerRequestSchema } from "../src/mcp/contracts.js";
import { commitMcpSession, reserveMcpSession } from "../src/mcp/session.js";
import { createTerminalStore } from "../src/mcp/lifecycle.js";
import { exportMasterAgentContext } from "../src/benchmark/master-context.js";
import { analyzeBenchmarkCosts } from "../src/benchmark/cost-analysis.js";
import { loadCostTrial } from "../src/benchmark/cost-artifacts.js";

test("benchmark context exports ordinary delivery and basic session timing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-benchmark-context-"));
  const workspaceRoot = path.join(root, "workspace");
  const sessionDirectory = path.join(root, "freecontext-sessions");
  await mkdir(workspaceRoot);
  await mkdir(path.join(root, "sessions"));
  try {
    const reservation = await reserveMcpSession({
      request: FreeContextCallerRequestSchema.parse({ question: "trace the route" }),
      invocationId: "invocation-context",
      callId: "call-context",
      workspaceRoot,
      workspaceRevision: "unversioned",
      sessionDirectory,
      now: () => new Date("2026-09-02T00:00:00.000Z"),
    });
    const decision = createTerminalStore().tryClaim({
      invocationId: reservation.invocation.invocationId,
      winner: "worker",
      decidedAt: "2026-09-02T00:00:01.000Z",
      lateDiagnosticFile: null,
    });
    assert.ok(decision);
    await commitMcpSession({
      reservation,
      capture: null,
      runtimeEvents: [],
      result: {
        status: "complete",
        text: "ordinary answer",
        errorCode: null,
        sessionId: reservation.invocation.sessionId,
        sessionFile: reservation.invocation.sessionFile,
      },
      terminalDecision: decision,
      terminalError: null,
      now: () => new Date("2026-09-02T00:00:02.000Z"),
    });
    await writeFile(path.join(root, "sessions", "master.jsonl"), [
      JSON.stringify({ type: "function_call", name: "gather_context", call_id: "call-context", arguments: JSON.stringify({ question: "trace the route" }) }),
      JSON.stringify({ type: "function_call_output", call_id: "call-context", output: `ordinary answer\n\nSession: ${reservation.invocation.sessionId}` }),
      "",
    ].join("\n"), "utf8");

    const outputPath = await exportMasterAgentContext({ agentDir: root, taskName: "task-context" });
    const exported = JSON.parse(await readFile(outputPath, "utf8")) as {
      schemaVersion: string;
      freeContextCalls: Array<Record<string, unknown>>;
      freeContextTransport: Array<Record<string, unknown>>;
    };
    assert.equal(exported.schemaVersion, "freecontext-master-agent-context-v4");
    assert.equal(exported.freeContextCalls.length, 1);
    assert.equal(exported.freeContextCalls[0]?.callId, "call-context");
    assert.equal(exported.freeContextCalls[0]?.outputToMasterAgent, `ordinary answer\n\nSession: ${reservation.invocation.sessionId}`);
    assert.equal(exported.freeContextCalls[0]?.fullSessionFile, `freecontext-sessions/${reservation.invocation.sessionId}.json`);
    assert.equal(exported.freeContextTransport[0]?.latencyMs, 2_000);

    await writeFile(path.join(root, "trajectory.json"), JSON.stringify({
      steps: [
        { source: "user", message: "trace the route" },
        { source: "agent", message: "done" },
      ],
      final_metrics: {},
    }), "utf8");
    const trial = await loadCostTrial({ taskId: "task-context", success: true, agentDir: root });
    assert.equal(trial.freeContextCalls, 1);
    assert.deepEqual(trial.subagentDelivered, [`ordinary answer\n\nSession: ${reservation.invocation.sessionId}`]);
    const report = await analyzeBenchmarkCosts(
      { schemaVersion: "freecontext-cost-input-v1", trials: [{ taskId: "task-context", success: true, agentDir: root }] },
      { countBatch: async (texts) => texts.map((text) => text.length) },
    );
    const population = report.population as { freeContextCalls: number };
    const aggregate = report.aggregate as { subagentDeliveredVisible: { total: number } };
    assert.equal(population.freeContextCalls, 1);
    assert.equal(aggregate.subagentDeliveredVisible.total, trial.subagentDelivered[0]?.length);

    await unlink(outputPath);
    const unreferenced = await reserveMcpSession({
      request: FreeContextCallerRequestSchema.parse({ question: "unreferenced" }),
      invocationId: "invocation-unreferenced",
      callId: "call-unreferenced",
      workspaceRoot,
      workspaceRevision: "unversioned",
      sessionDirectory,
      now: () => new Date("2026-09-02T00:00:00.000Z"),
    });
    const unreferencedDecision = createTerminalStore().tryClaim({
      invocationId: unreferenced.invocation.invocationId,
      winner: "worker",
      decidedAt: "2026-09-02T00:00:01.000Z",
      lateDiagnosticFile: null,
    });
    assert.ok(unreferencedDecision);
    await commitMcpSession({
      reservation: unreferenced,
      capture: null,
      runtimeEvents: [],
      result: {
        status: "complete",
        text: "unreferenced answer",
        errorCode: null,
        sessionId: unreferenced.invocation.sessionId,
        sessionFile: unreferenced.invocation.sessionFile,
      },
      terminalDecision: unreferencedDecision,
      terminalError: null,
      now: () => new Date("2026-09-02T00:00:02.000Z"),
    });
    await assert.rejects(
      () => exportMasterAgentContext({ agentDir: root, taskName: "task-context" }),
      /not referenced by a master-agent gather_context call/u,
    );
    const allowedPath = await exportMasterAgentContext({ agentDir: root, taskName: "task-context", allowUnreferencedSessions: true });
    const allowed = JSON.parse(await readFile(allowedPath, "utf8")) as { freeContextCalls: unknown[] };
    assert.equal(allowed.freeContextCalls.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
