import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FreeContextConfig } from "../src/config.js";
import type { PiBindings } from "../src/runtime/pi-bindings.js";
import { loadPiBindings } from "../src/runtime/pi-bindings.js";
import { runExplorer } from "../src/runtime/run.js";
import { createWorkspace } from "../src/tools/workspace.js";

const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-smoke-"));
try {
  await writeFile(path.join(root, "sample.js"), "export function answer() {\n  return 42;\n}\n", "utf8");
  const workspace = await createWorkspace(root);
  const response = {
    role: "assistant" as const,
    content: [
      {
        type: "text" as const,
        text: "<final_answer>\nsummary: The sample exports answer.\nevidence:\n- sample.js:1-3 — Defines the exported function.\ngaps:\n- none\n</final_answer>",
      },
    ],
    api: "anthropic-messages" as const,
    provider: "freecontext-custom",
    model: "test-model",
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: 0,
  };
  const loaded = await loadPiBindings("anthropic");
  const runAgentLoop: PiBindings["runAgentLoop"] = async (prompts, _context, _config, emit) => {
    await emit({ type: "agent_start" });
    await emit({ type: "turn_start" });
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
      throw new Error("baseline mock attempted a provider summary request");
    },
  };
  const config: FreeContextConfig = {
    api: "anthropic",
    authMode: "bearer",
    apiKey: "test-key",
    baseUrl: "https://example.invalid",
    model: "test-model",
    promptPath: path.resolve("prompts/explorer.md"),
    envFilePath: "/tmp/freecontext-smoke.env",
    envFileLoaded: false,
    maxTurns: 4,
    maxToolCalls: 8,
    maxOutputTokens: 1024,
    requestTimeoutMs: 1000,
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
      supportsStore: false,
      maxTokensField: "max_tokens",
    },
  };
  const result = await runExplorer({
    query: "Find answer",
    cwd: root,
    dependencies: {
      config,
      workspace,
      bindings,
      repositoryTools: {
        tools: [],
        names: ["read", "rg", "glob"],
        executables: { rg: null, jq: null, bat: null },
      },
      systemPrompt: "test",
    },
  });
  if (!result.answer.includes("sample.js:1-3")) throw new Error("mock smoke validation failed");
  if (summaryCalls !== 0) throw new Error("baseline mock unexpectedly called the summary transport");
  if (result.metrics.primary.compactions !== 0) throw new Error("baseline mock unexpectedly compacted context");
  process.stdout.write(`${result.answer}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
