import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { FreeContextCallerRequestSchema } from "../src/mcp/contracts.js";
import { createGatherContextHandler } from "../src/mcp/tool.js";
import { runExplorer } from "../src/runtime/run.js";
import { compileFreeContextResult } from "../src/output/text-result.js";
import { assistantText, baseConfig, baseRouteConfig, fakeBindings } from "./helpers.js";

const counter = { countBatch: async (texts: readonly string[]) => texts.map((text) => Math.ceil(text.length / 4)) };

test("explicit capture status survives an incomplete summary without conflating commands or parsing logs", async () => {
  const invocation = { invocationId: "i", callId: "c", workspaceRoot: "/unused", workspaceRevision: "r", sessionId: "s", sessionFile: "/unused/session.json" };
  const capture = { command: "cat test.log", exit_code: 2, testStatus: { exit_code: 0, timedOut: false, timeout: 300000 }, results: [{ exit_code: 1, truncated: false }], output: '{"exit_code": 99}', payload: { exit_code: 88 } };
  const result = await compileFreeContextResult({ intent: "test result", output: JSON.stringify(capture) }, invocation, "Log unavailable.");
  assert.match(result.text, /\$\["exit_code"\] = 2/);
  assert.match(result.text, /\$\["testStatus"\]\["exit_code"\] = 0/);
  assert.match(result.text, /\$\["testStatus"\]\["timedOut"\] = false/);
  assert.match(result.text, /\$\["testStatus"\]\["timeout"\] = 300000/);
  assert.match(result.text, /\$\["results"\]\[0\]\["exit_code"\] = 1/);
  assert.match(result.text, /\$\["results"\]\[0\]\["truncated"\] = false/);
  assert.doesNotMatch(result.text, /99|88/);
  const plain = await compileFreeContextResult({ intent: "status", output: 'log exit_code: 0' }, invocation, "Original answer", { errorCode: "PROVIDER_FATAL" });
  assert.equal(plain.text, "Original answer");
  assert.equal(plain.status, "partial");
  assert.equal(plain.errorCode, "PROVIDER_FATAL");
});

test("complete capture including a large tail reaches the tool-free model and is recoverable after success or failure", async () => {
  const root = await realpath(await mkdtemp(path.join(process.cwd(), ".work", "command-summary-")));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const output = 'command: rg -n example\nexit: 1\nstderr: failure\n' + "原文 evidence\n".repeat(7000) + "src/tail.ts:99 decisive exception";
  try {
    for (const mode of ["success", "provider-failure", "overflow"] as const) {
      const fail = mode !== "success";
      let calls = 0;
      const handler = createGatherContextHandler({
        tokenCounter: counter, sessionDirectory: path.join(root, mode),
        runExplorer: (options) => runExplorer({ ...options, dependencies: {
          tokenCounter: counter, routeConfig: baseRouteConfig([baseConfig({ contextWindow: mode === "overflow" ? 17000 : 65536, contextCompactionEnabled: false, effectiveToolOutputBytes: 4096, providerRetryDelaysMs: [] })]),
          bindings: fakeBindings(async (prompts, context, _config, emit) => {
            calls += 1;
            assert.deepEqual(context.tools, []);
            assert.deepEqual(context.messages, []);
            assert.equal(prompts.length, 1);
            const prompt = prompts[0];
            assert.ok(prompt?.role === "user" && typeof prompt.content === "string");
            assert.match(prompt.content, /Intent: Explain the failure/);
            assert.match(prompt.content, /src\/tail.ts:99 decisive exception$/);
            assert.doesNotMatch(prompt.content, /\ufffd/u);
            assert.ok(prompt.content.includes(output));
            if (fail) throw new Error("synthetic provider failure");
            const answer = assistantText("The capture reports exit 1 and stderr failure.");
            await emit({ type: "turn_end", message: answer, toolResults: [] });
            return [...prompts, answer];
          }),
        } }),
      });
      const result = await handler({ intent: "Explain the failure", output }, {
        invocationId: `i-${fail}`, callId: `c-${fail}`, workspaceRoot: workspace, workspaceRevision: "test",
      });
      assert.equal(calls, mode === "overflow" ? 0 : 1);
      const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      assert.ok(!text.includes("原文 evidence"));
      assert.match(text, /Captured output:/);
      if (mode === "overflow") assert.match(text, /Submit a smaller capture segment/);
      assert.equal(Boolean(result.isError), fail);
      const directory = path.join(root, mode);
      const filename = (await readdir(directory)).find((name) => name.endsWith(".output.txt"));
      assert.ok(filename);
      assert.equal(await readFile(path.join(directory, filename), "utf8"), output);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("short and empty captures bypass provider and preserve an explicit zero-call fact", async () => {
  assert.throws(() => FreeContextCallerRequestSchema.parse({ question: "old interface" }));
  for (const output of ["", " exit: 2\nstderr: missing file\n"]) {
    const result = await runExplorer({
      request: { intent: "Read status", output },
      invocation: { invocationId: "i", callId: "c", workspaceRoot: "/unused", workspaceRevision: "r", sessionId: "s", sessionFile: "/unused/session.json" },
      dependencies: { tokenCounter: counter, bindings: fakeBindings(async () => { assert.fail("short capture called the provider"); }) },
    });
    assert.equal(result.summaryBypassed, true);
    assert.equal(result.status, "complete");
    if (output) assert.ok(result.text.includes(output));
  }
});

test("a real Pi loop stops after one malformed tool-bearing summary without exploration", async () => {
  const root = await realpath(await mkdtemp(path.join(process.cwd(), ".work", "summary-loop-")));
  let calls = 0;
  try {
    const result = await runExplorer({
      request: { intent: "Extract evidence", output: "evidence\n".repeat(400) },
      invocation: { invocationId: "i", callId: "c", workspaceRoot: root, workspaceRevision: "r", sessionId: "s", sessionFile: path.join(root, "unused.json") },
      dependencies: {
        tokenCounter: counter, routeConfig: baseRouteConfig(),
        bindings: fakeBindings(runAgentLoop, { streamSimple: (_model, context) => {
          calls += 1;
          assert.deepEqual(context.tools, []);
          const stream = createAssistantMessageEventStream();
          const message = assistantText("", { content: [{ type: "toolCall", id: "bad", name: "read", arguments: { path: "secret" } }], stopReason: "toolUse" });
          queueMicrotask(() => { stream.push({ type: "done", reason: "toolUse", message }); stream.end(); });
          return stream;
        } }),
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.status, "partial");
  } finally { await rm(root, { recursive: true, force: true }); }
});
