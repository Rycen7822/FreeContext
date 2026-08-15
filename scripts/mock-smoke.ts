import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { executeCli } from "../src/cli.js";
import type { CliIo } from "../src/cli.js";
import type { FreeContextConfig } from "../src/config.js";
import { OutputValidationError } from "../src/errors.js";
import { FreeContextResultSchema, serializeForModel } from "../src/mcp/contracts.js";
import type { FreeContextInvocationContext, FreeContextRequest } from "../src/mcp/contracts.js";
import type { PiBindings } from "../src/runtime/pi-bindings.js";
import { loadPiBindings } from "../src/runtime/pi-bindings.js";
import { runExplorer } from "../src/runtime/run.js";
import { createWorkspace } from "../src/tools/workspace.js";

const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-smoke-"));
const sessionDirectory = await mkdtemp(path.join(os.tmpdir(), "freecontext-smoke-sessions-"));
try {
  await writeFile(path.join(root, "sample.js"), "export function answer() {\n  return 42;\n}\n", "utf8");
  const workspace = await createWorkspace(root);
  const response = {
    role: "assistant" as const,
    content: [{
      type: "toolCall" as const,
      id: "submit-smoke",
      name: "submit_evidence",
      arguments: {
        summary: "The sample exports answer.",
        evidence: [{
          role: "implementation",
          question_id: "impl",
          path: "sample.js",
          start_line: 1,
          end_line: 3,
          focus_line: 1,
          why: "Defines the exported function.",
        }],
        gaps: [{ question_id: "tests", reason: "No test was found." }],
      },
    }],
    api: "anthropic-messages" as const,
    provider: "freecontext-custom",
    model: "test-model",
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: 0,
  };
  const loaded = await loadPiBindings("anthropic");
  const runAgentLoop: PiBindings["runAgentLoop"] = async (prompts, context, loopConfig, emit) => {
    await emit({ type: "agent_start" });
    await emit({ type: "turn_start" });
    await emit({
      type: "tool_execution_end",
      toolCallId: "read-smoke",
      toolName: "read",
      result: {
        content: [{ type: "text", text: "[read sample.js:1-3]\n1 export function answer() {\n2   return 42;\n3 }" }],
        details: { tool: "read", path: "sample.js", startLine: 1, actualEndLine: 3, truncated: false },
      },
      isError: false,
    });
    const submit = context.tools?.find((tool) => tool.name === "submit_evidence");
    const call = response.content[0];
    if (!submit || !call || call.type !== "toolCall") throw new Error("mock submit tool was unavailable");
    const before = await loopConfig.beforeToolCall?.({ assistantMessage: response, toolCall: call, args: call.arguments, context });
    if (before?.block) throw new Error("mock submit was unexpectedly blocked");
    const submitted = await submit.execute(call.id, call.arguments);
    await emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: submitted, isError: false });
    await emit({ type: "turn_end", message: response, toolResults: [] });
    await emit({ type: "agent_end", messages: [...prompts, response] });
    return [...prompts, response];
  };
  let summaryCalls = 0;
  const bindings: PiBindings = {
    ...loaded,
    runAgentLoop,
    streamSimple: () => {
      summaryCalls += 1;
      throw new Error("mock attempted a second provider request");
    },
  };
  const config: FreeContextConfig = {
    target: "smoke",
    provider: "smoke-provider",
    api: "anthropic",
    authMode: "bearer",
    apiKey: "test-key",
    baseUrl: "https://example.invalid",
    model: "test-model",
    promptPath: path.resolve("prompts/explorer.md"),
    configFilePath: "/tmp/freecontext-smoke.toml",
    maxTurns: 4,
    maxToolCalls: 8,
    maxOutputTokens: 1024,
    requestTimeoutMs: 1000,
    providerRetryDelaysMs: [1, 2, 4],
    toolTimeoutMs: 1000,
    maxToolOutputBytes: 8192,
    maxParallelTools: 2,
    contextWindow: 8192,
    contextCompactionEnabled: true,
    contextReserveTokens: 4096,
    contextKeepRecentTokens: 2048,
    effectiveToolOutputBytes: 8192,
    temperature: 0,
    thinkingLevel: "off",
    headers: {},
    openAICompat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
      supportsStrictMode: false,
      supportsRequiredToolChoice: true,
      supportsStore: false,
      maxTokensField: "max_tokens",
    },
  };
  const request: FreeContextRequest = {
    taskText: "Find answer",
    knownRefs: [{ kind: "path", path: "sample.js" }],
    evidenceQuestions: [
      { id: "impl", role: "implementation", question: "Where is answer implemented?", required: true },
      { id: "tests", role: "test", question: "How is answer tested?", required: false },
    ],
  };
  const invocation: FreeContextInvocationContext = {
    invocationId: "smoke-invocation",
    callId: "smoke-call",
    workspaceRoot: workspace.root,
    workspaceRevision: "smoke-revision",
    sessionId: "smoke-session",
    sessionFile: path.join(sessionDirectory, "direct-session.json"),
  };
  const result = await runExplorer({
    request,
    invocation,
    dependencies: {
      routeConfig: { route: "smoke", configFilePath: config.configFilePath, fallbackOn: [], targets: [config] },
      workspace,
      bindings,
      tokenCounter: { countBatch: async (texts) => texts.map((text) => Math.ceil(text.length / 4)) },
      repositoryTools: { tools: [], names: ["read", "rg", "glob"], executables: { rg: null, jq: null, bat: null } },
      systemPrompt: "test",
    },
  });
  if (result.status !== "ready" || result.errorCode !== null) {
    throw new Error("mock smoke did not preserve validated typed evidence");
  }
  if (result.evidence[0]?.path !== "sample.js") throw new Error("mock smoke lost validated evidence");
  if (summaryCalls !== 0) throw new Error("mock smoke unexpectedly made a second provider call");

  const ioFixture = (): { io: CliIo; stdout: string[]; stderr: string[] } => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      stdout,
      stderr,
      io: {
        stdin: Object.assign(Readable.from([]), { isTTY: true }),
        stdout: { write: ((chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; }) as CliIo["stdout"]["write"] },
        stderr: { write: ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; }) as CliIo["stderr"]["write"] },
      },
    };
  };
  for (const format of ["json", "text"] as const) {
    const fixture = ioFixture();
    const sessionFile = path.join(sessionDirectory, `cli-${format}.json`);
    const exitCode = await executeCli(
      ["explore", "--format", format, "--benchmark-session-file", sessionFile, "Find answer"],
      fixture.io,
      { runExplorer: async (options) => FreeContextResultSchema.parse({
        ...result,
        sessionId: options.invocation.sessionId,
        sessionFile: options.invocation.sessionFile,
      }) },
    );
    if (exitCode !== 0) throw new Error(`${format} CLI did not accept a ready result`);
    if (format === "json") {
      if (FreeContextResultSchema.parse(JSON.parse(fixture.stdout.join(""))).status !== "ready") {
        throw new Error("CLI JSON was not the canonical result");
      }
    } else if (!fixture.stdout.join("").startsWith("Status: ready\n")) {
      throw new Error("CLI text did not use the canonical serializer");
    }
  }

  const invalid = ioFixture();
  const invalidSession = path.join(sessionDirectory, "cli-invalid.json");
  const invalidExit = await executeCli(
    ["explore", "--benchmark-session-file", invalidSession, "Find answer"],
    invalid.io,
    { runExplorer: async () => {
      throw new OutputValidationError("Explorer output failed validation.", { rawOutput: "RAW_MODEL_SECRET_SENTINEL" });
    } },
  );
  if (invalidExit === 0) throw new Error("invalid CLI fixture returned success");
  if (`${invalid.stdout.join("")}\n${invalid.stderr.join("")}`.includes("RAW_MODEL_SECRET_SENTINEL")) {
    throw new Error("invalid CLI output leaked raw model output");
  }
  process.stdout.write(`${serializeForModel(result)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(sessionDirectory, { recursive: true, force: true });
}
