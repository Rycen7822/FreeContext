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
  assert.match(prompt, /Each required question is an independent acceptance slot/iu);
  assert.match(prompt, /Caller-role relationships are exhaustive by contract/iu);
  assert.match(prompt, /unclosed caller enumeration must remain a gap and produce `partial`/iu);
  assert.match(prompt, /Make the smallest bounded read or search that closes the current target/iu);
  assert.match(prompt, /path discovery, `rg` for symbols/u);
  assert.match(prompt, /existing owner or extension seam proving absence is complete negative evidence/iu);
  assert.match(prompt, /When required allocation is covered.*call `submit_evidence` next and alone/iu);
  assert.match(prompt, /call `submit_evidence` next and alone/iu);
  assert.match(prompt, /An `exhaustive` target needs every discovered member.*explicit gaps/iu);
  assert.match(prompt, /Do not send `target_id`/iu);
  assert.match(prompt, /never submit a seventh evidence item/iu);
  assert.doesNotMatch(prompt, /Turn [1-9]/u);
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
  assert.match(prompt, /brief and self-contained, normally 8–24 lines/iu);
  assert.match(prompt, /Required slots use max\(minimumSpans, declared target count\).*missing any required question keeps the result partial/iu);
  assert.match(prompt, /do not rely on post-hoc fitter trimming/iu);
  assert.doesNotMatch(prompt, /previous_output|repair/iu);
});
