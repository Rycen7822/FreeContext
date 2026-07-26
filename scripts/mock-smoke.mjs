import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runExplorer } from "../src/runtime/run.mjs";
import { createWorkspace } from "../src/tools/workspace.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-smoke-"));
try {
  await writeFile(path.join(root, "sample.js"), "export function answer() {\n  return 42;\n}\n", "utf8");
  const workspace = await createWorkspace(root);
  const fakeType = new Proxy({}, { get: () => (...args) => ({ args }) });
  const response = {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "<final_answer>\nsummary: The sample exports answer.\nevidence:\n- sample.js:1-3 — Defines the exported function.\ngaps:\n- none\n</final_answer>",
      },
    ],
    usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30 },
    stopReason: "stop",
  };
  const bindings = {
    Type: fakeType,
    streamSimple: () => {},
    runAgentLoop: async (prompts, _context, _config, emit) => {
      await emit({ type: "agent_start" });
      await emit({ type: "turn_start" });
      await emit({ type: "turn_end", message: response, toolResults: [] });
      await emit({ type: "agent_end", messages: [...prompts, response] });
      return [...prompts, response];
    },
  };
  const config = {
    api: "anthropic",
    authMode: "bearer",
    apiKey: "test-key",
    baseUrl: "https://example.invalid",
    model: "test-model",
    promptPath: path.resolve("prompts/explorer.md"),
    maxTurns: 4,
    maxToolCalls: 8,
    maxOutputTokens: 1024,
    requestTimeoutMs: 1000,
    toolTimeoutMs: 1000,
    maxToolOutputBytes: 8192,
    maxParallelTools: 2,
    contextWindow: 8192,
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
      repositoryTools: { tools: [], names: ["read", "rg", "glob"], executables: {} },
      systemPrompt: "test",
    },
  });
  if (!result.answer.includes("sample.js:1-3")) throw new Error("mock smoke validation failed");
  process.stdout.write(`${result.answer}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
