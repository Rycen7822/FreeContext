import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FreeContextRequest } from "../src/mcp/contracts.js";
import { buildUserPrompt, loadSystemPrompt } from "../src/prompt.js";
import { createWorkspace } from "../src/tools/workspace.js";

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

test("default explorer reserves the fourth turn for terminal submission", async () => {
  const prompt = await readFile(new URL("../prompts/explorer.md", import.meta.url), "utf8");
  assert.match(prompt, /Map each named concern to one concrete target/u);
  assert.match(prompt, /targeted-search wave seeks a line or symbol candidate for each named concern of every required question/u);
  assert.match(prompt, /globbed paths are not content candidates/u);
  assert.match(prompt, /Turn 2: read one role-matched candidate per required question/u);
  assert.match(prompt, /Test-role evidence is an actual test\/spec file or inline test block/iu);
  assert.match(prompt, /never a production helper whose name contains test/iu);
  assert.match(prompt, /With 6 questions, no question may take a second span/u);
  assert.match(prompt, /Stop when each named concern has a role-matched decisive span/u);
  assert.match(prompt, /fill free slots with observed decisive secondary spans needed by the task/iu);
  assert.match(prompt, /Turn 3 only reads located spans with `read`\/`bat` or submits/u);
  assert.match(prompt, /a late search cannot be cited/u);
  assert.match(prompt, /On turn 4, submit the best supported result alone/u);
  assert.match(prompt, /there is no repair turn/u);
  assert.match(prompt, /with 6 questions, include at most one per question/iu);
  assert.match(prompt, /never substitute another role or put the same question in both evidence and gaps/iu);
  assert.doesNotMatch(prompt, /Turn 5/u);
});

test("user prompt preserves the exact task and renders typed evidence inputs", () => {
  const request: FreeContextRequest = {
    taskText: "  find x without rewriting this text  ",
    knownRefs: [
      { kind: "stack", path: "src/a.ts", line: 9 },
      { kind: "symbol", symbol: "run", path: "src/a.ts" },
    ],
    evidenceQuestions: [
      { id: "impl", role: "implementation", question: "Where is x implemented?", required: true },
      { id: "tests", role: "test", question: "How is x tested?", required: false },
    ],
  };
  const prompt = buildUserPrompt(request);
  assert.match(prompt, /<task>\n  find x without rewriting this text  \n<\/task>/u);
  assert.match(prompt, /\[stack\] src\/a\.ts:9/u);
  assert.match(prompt, /\[symbol\] run in src\/a\.ts/u);
  assert.match(prompt, /\[implementation\]\[impl\]\[required\] Where is x implemented\?/u);
  assert.match(prompt, /\[test\]\[tests\]\[optional\] How is x tested\?/u);
  assert.doesNotMatch(prompt, /previous_output|repair/iu);
});
