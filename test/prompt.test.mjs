import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildRepairPrompt, buildUserPrompt, loadSystemPrompt } from "../src/prompt.mjs";
import { createWorkspace } from "../src/tools/workspace.mjs";

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

test("user and repair prompts preserve task boundaries", () => {
  assert.match(buildUserPrompt("find x"), /<request>\nfind x\n<\/request>/u);
  assert.match(buildRepairPrompt(["bad range"]), /- bad range/u);
  assert.match(buildRepairPrompt(["bad range"]), /Do not call tools/u);
});
