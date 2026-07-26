import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runExplorer } from "../src/runtime/run.mjs";
import { createWorkspace } from "../src/tools/workspace.mjs";
import { assistantText, baseConfig, FakeType } from "./helpers.mjs";

function fakeDependencies(root, responses) {
  let index = 0;
  const bindings = {
    Type: FakeType,
    streamSimple: () => {},
    runAgentLoop: async (prompts, _context, _config, emit) => {
      const response = responses[index++];
      await emit({ type: "turn_start" });
      await emit({ type: "turn_end", message: response, toolResults: [] });
      return [...prompts, response];
    },
  };
  return createWorkspace(root).then((workspace) => ({
    config: baseConfig(),
    workspace,
    bindings,
    repositoryTools: { tools: [], names: ["read", "rg", "glob"], executables: {} },
    systemPrompt: "system",
  }));
}

test("runExplorer returns locally validated evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-run-"));
  try {
    await writeFile(path.join(root, "a.js"), "const a = 1;\nexport { a };\n", "utf8");
    const valid = assistantText(
      "<final_answer>\nsummary: a is exported.\nevidence:\n- a.js:1-2 — Defines and exports a.\ngaps:\n- none\n</final_answer>",
    );
    const result = await runExplorer({
      query: "find a",
      cwd: root,
      dependencies: await fakeDependencies(root, [valid]),
    });
    assert.equal(result.summary, "a is exported.");
    assert.equal(result.evidence[0].path, "a.js");
    assert.equal(result.metrics.repaired, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runExplorer performs one no-tool format repair", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-run-"));
  try {
    await writeFile(path.join(root, "a.js"), "const a = 1;\n", "utf8");
    const invalid = assistantText("The answer is a.js.");
    const repaired = assistantText(
      "<final_answer>\nsummary: a is defined.\nevidence:\n- a.js:1-1 — Defines a.\ngaps:\n- none\n</final_answer>",
    );
    const result = await runExplorer({
      query: "find a",
      cwd: root,
      dependencies: await fakeDependencies(root, [invalid, repaired]),
    });
    assert.equal(result.metrics.repaired, true);
    assert.equal(result.evidence[0].start, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
