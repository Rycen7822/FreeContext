import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FreeContextRequest } from "../src/mcp/contracts.js";
import { buildUserPrompt, loadSystemPrompt } from "../src/prompt.js";
import { createWorkspace } from "../src/tools/workspace.js";
import { topicTarget } from "./helpers.js";

test("external prompt template receives workspace, tools, and overview", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freecontext-$&-"));
  try {
    await writeFile(path.join(directory, "a.js"), "x\n", "utf8");
    const promptPath = path.join(directory, "prompt.md");
    await writeFile(promptPath, "W={{WORKSPACE}}\nT={{TOOLS}}\nO={{OVERVIEW}}\n", "utf8");
    const workspace = await createWorkspace(directory);
    const prompt = await loadSystemPrompt({ promptPath, workspace, toolNames: ["read", "rg"] });
    assert.match(prompt, /W=.*freecontext-\$&-/u);
    assert.match(prompt, /T=`read`, `rg`/u);
    assert.match(prompt, /\[file\] a\.js/u);
    assert.equal(prompt.includes("{{WORKSPACE}}"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("default explorer follows adaptive canonical feedback", async () => {
  const prompt = await readFile(new URL("../prompts/explorer.md", import.meta.url), "utf8");
  assert.match(prompt, /Treat each question's one structured target as one subject, one requested fact kind, and its declared coverage mode/u);
  assert.match(prompt, /Choose the smallest search or read that can close the current coverage deficit/u);
  assert.match(prompt, /Use `glob` for path discovery, `rg` for symbols/u);
  assert.match(prompt, /Test-role evidence is an actual test\/spec file or inline test block/iu);
  assert.match(prompt, /never a production helper whose name contains test/iu);
  assert.match(prompt, /existing owner or extension seam that proves the behavior is absent is a complete negative answer/iu);
  assert.match(prompt, /gap means the target fact could not be determined/iu);
  assert.match(prompt, /When Known references are present, start from those exact paths or symbols/iu);
  assert.match(prompt, /Once every required target has its role-matched coverage or an explicit target gap, make `submit_evidence` the next/iu);
  assert.match(prompt, /`evidenceQuestions` and their required coverage slots are the only stopping target/iu);
  assert.match(prompt, /make `submit_evidence` the next and only tool call/iu);
  assert.match(prompt, /Do not issue duplicate successful tool calls or overlapping reads/iu);
  assert.match(prompt, /At the end of every repository-tool batch, check each declared slot/iu);
  assert.match(prompt, /Do not start another search or read merely to broaden a supported slot/iu);
  assert.match(prompt, /Stop naturally when the canonical evaluator reports `ready` or a typed terminal outcome/u);
  assert.match(prompt, /returned canonical feedback as part of this same exploration session/u);
  assert.match(prompt, /resolve the listed gaps and submit an updated candidate/u);
  assert.match(prompt, /Configured turn and tool-call budgets are soft liveness checkpoints/u);
  assert.match(prompt, /search output alone does not extend it/u);
  assert.match(prompt, /checkpoint during exploration/u);
  assert.match(prompt, /every citation must stay within one repository-tool observation even when adjacent observations touch/iu);
  assert.match(prompt, /required coverage slots .* must sum to at most six/iu);
  assert.match(prompt, /For each exhaustive target, also submit one coverage record with all discovered members and explicit gaps/iu);
  assert.match(prompt, /preserve it for a later invocation instead of lowering, merging, or silently dropping/iu);
  assert.match(prompt, /If a required target is only partly supported, submit its observed evidence and a target-scoped gap/iu);
  assert.match(prompt, /smallest self-contained observed range/iu);
  assert.match(prompt, /declaration line alone is insufficient/iu);
  assert.doesNotMatch(prompt, /Turn [1-9]/u);
  assert.doesNotMatch(prompt, /no repair turn|late search cannot be cited/u);
});

test("user prompt preserves the exact task and renders typed evidence inputs", () => {
  const request: FreeContextRequest = {
    taskText: "  find x without rewriting this text  ",
    workUnit: { outcome: "edit", goal: "Update x." },
    knownRefs: [
      { kind: "stack", path: "src/a.ts", line: 9 },
      { kind: "symbol", symbol: "run", path: "src/a.ts" },
    ],
    evidenceQuestions: [
      { id: "impl", role: "implementation", question: "Where is x implemented?", required: true, minimumSpans: 2, coverageTargets: [topicTarget("x-implementation", "x implementation", "location")] },
      { id: "tests", role: "test", question: "How is x tested?", required: false, coverageTargets: [topicTarget("x-tests", "x tests", "verification")] },
    ],
  };
  const prompt = buildUserPrompt(request);
  assert.match(prompt, /<task>\n  find x without rewriting this text  \n<\/task>/u);
  assert.match(prompt, /\[stack\] src\/a\.ts:9/u);
  assert.match(prompt, /\[symbol\] run in src\/a\.ts/u);
  assert.match(prompt, /Current work unit: \[edit\] Update x\./u);
  assert.match(prompt, /\[implementation\]\[impl\]\[required\]\[minimum-spans=2\] \[target=x-implementation:topic:x implementation:location:single\] Where is x implemented\?/u);
  assert.match(prompt, /\[test\]\[tests\]\[optional\] \[target=x-tests:topic:x tests:verification:single\] How is x tested\?/u);
  assert.match(prompt, /smallest self-contained observed range/iu);
  assert.doesNotMatch(prompt, /previous_output|repair/iu);
});
