import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { FREECONTEXT_ELIGIBILITY_POLICY, FreeContextCallerRequestSchema } from "../src/mcp/contracts.js";

test("implicit discovery routes complex reads to one MCP tool without copying eligibility policy", async () => {
  const [skill, metadata] = await Promise.all([
    readFile(new URL("../skills/freecontext/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../skills/freecontext/agents/openai.yaml", import.meta.url), "utf8"),
  ]);

  const description = skill.match(
    /^---\nname: freecontext\ndescription: (?<description>[^\n]+)\n---\n/u,
  )?.groups?.description;
  assert.ok(description);
  assert.ok(Buffer.byteLength(skill, "utf8") <= 3_200);
  assert.ok([...description].length <= 420);
  assert.equal(
    description,
    "Delegate multi-file, cross-module, long-document, multi-document, or source-bound exploration to gather_context; follow its structured nextAction and continuation contract.",
  );
  for (const gate of FREECONTEXT_ELIGIBILITY_POLICY.gates) assert.equal(skill.includes(gate.instruction), false);
  assert.match(skill, /read this file first; the next cell calls `tools\.mcp__freecontext__gather_context`/iu);
  for (const trigger of ["multi-file", "cross-module", "long-document", "source-bound"]) {
    assert.ok(description.includes(trigger));
  }
  assert.match(description, /structured nextAction and continuation contract/iu);
  assert.doesNotMatch(description, /second search batch|third unrelated path/iu);
  assert.doesNotMatch(skill, /never auto-trigger|only (?:after )?an explicit user request/iu);
  assert.match(skill, /```js\n\/\/ @exec: \{"yield_time_ms": 300000, "max_output_tokens": 10000\}/u);
  const codeStart = skill.indexOf("```js\n");
  const pragma = skill.indexOf("// @exec: {\"yield_time_ms\": 300000, \"max_output_tokens\": 10000}");
  const argsCue = skill.indexOf("// Construct documented args here.");
  const gatherCall = skill.indexOf("const result = await tools.mcp__freecontext__gather_context(args);");
  assert.equal(pragma, codeStart + "```js\n".length);
  assert.ok(pragma < argsCue && argsCue < gatherCall);
  assert.doesNotMatch(skill, /Use after constructing `args`/u);
  assert.match(skill, /gather_context` alone/u);
  assert.match(skill, /Never parallelize or batch/u);
  assert.match(skill, /During dispatch do no native or other tool work/u);
  assert.match(skill, /typeof tools\.mcp__freecontext__gather_context !== "function"/u);
  assert.doesNotMatch(skill, /ALL_TOOLS/u);
  assert.equal(skill.match(/await tools\.mcp__freecontext__gather_context\(args\)/gu)?.length, 1);
  assert.equal(skill.match(/\bnotify\(/gu)?.length ?? 0, 0);
  assert.equal(skill.match(/functions\.wait/gu)?.length, 1);
  assert.match(skill, /yield_time_ms: ?300000, ?max_tokens: ?10000/u);
  assert.match(skill, /terminalTexts\.length !== 1/u);
  assert.doesNotMatch(skill, /JSON\.stringify/u);
  assert.match(skill, /No waiting Hook/u);
  assert.match(skill, /Caller fields: `taskText`, `workUnit`, `evidenceQuestions`/u);
  const template = skill.match(/`(?<template>const args=\{[\s\S]+?\};)`/u)?.groups?.template;
  assert.ok(template);
  const templateArgs = runInNewContext(`${template}\nargs`, Object.create(null), { timeout: 100 });
  const parsedTemplate = FreeContextCallerRequestSchema.parse(templateArgs);
  assert.equal(parsedTemplate.workUnit.outcome, "edit");
  assert.equal(parsedTemplate.workUnit.goal, "Change goal.");
  assert.equal(parsedTemplate.evidenceQuestions.length, 1);
  assert.equal(parsedTemplate.evidenceQuestions[0]?.target.coverageMode, "single");
  assert.match(skill, /Default 2–4 concrete `single` targets/u);
  assert.match(skill, /`exhaustive` only for an explicit complete enumeration/u);
  assert.match(skill, /nearest owner\/seam\/caller\/test/u);
  assert.match(skill, /knownRefs\(path\/symbol\/stack\)/u);
  assert.match(skill, /Main agent owns edits, checks, Git, packages, and web/u);
  assert.doesNotMatch(skill, /\bworkspace_root\b/u);
  assert.match(skill, /Consume inline Evidence\/`nextAction` directly/u);
  assert.match(skill, /Before first edit\/check do not reread covered content/u);
  assert.match(skill, /`ready`\/`partial` include a handoff/u);
  assert.match(skill, /one cited-adjacent read only if critical context is omitted/iu);
  assert.match(skill, /Broader discovery calls FC/iu);
  assert.match(skill, /Copy `priorHandoff` verbatim/iu);
  assert.match(skill, /its `workUnit` exactly/iu);
  for (const origin of ["evidence_consumption", "edit", "check"]) assert.match(skill, new RegExp(`(?:${origin})`, "u"));
  assert.match(skill, /targetId,kind,scope,requiredFact,origin/iu);
  assert.match(skill, /Do not guess fields or reenter for adjacent context/iu);
  assert.doesNotMatch(skill, /complete unresolved question|same-unit|same gaps|Acceptance receipt|private acceptance receipt/iu);

  assert.match(metadata, /^  allow_implicit_invocation: true$/mu);
  assert.equal(metadata.match(/^    - type:/gmu)?.length, 1);
  assert.match(metadata, /^    - type: "mcp"$/mu);
  assert.equal(metadata.match(/^      value: "freecontext"$/gmu)?.length, 1);
  const shortDescription = metadata.match(/^  short_description: "([^"]+)"$/mu)?.[1];
  assert.equal(shortDescription, "First cell reads skill only; next calls gather_context");

  const routingSurface = `${skill}\n${metadata}`;
  for (const forbidden of [
    /freecontext explore/u,
    /_GUIDANCE/u,
    /\b(?:shell|poll(?:ing)?)\b/iu,
    /\bexplore_repository\b/u,
    /default_prompt:/u,
    /CLI fallback|Hook registration/u,
    /https?:\/\//u,
    /Manual compatibility command/u,
    /\b(?:TOKENRHYTHM|API_KEY|base_url|bearer)\b/u,
    /\b(?:provider|credentials?)\b/iu,
    /\b(?:DeepSWE|TaskNameXXX|returns-validated|mashumaro)\b/u,
  ]) {
    assert.doesNotMatch(routingSurface, forbidden);
  }
});

test("caller template emits only one canonical terminal text", async () => {
  const skill = await readFile(new URL("../skills/freecontext/SKILL.md", import.meta.url), "utf8");
  const caller = skill.match(/```js\n(?<code>[\s\S]+?)\n```/u)?.groups?.code;
  assert.ok(caller);

  type ToolResult = Readonly<{
    content: readonly Readonly<{ type: string; text?: string }>[];
    structuredContent?: unknown;
    _meta?: unknown;
  }>;
  type Caller = (
    tools: Readonly<{ mcp__freecontext__gather_context: (args: unknown) => Promise<ToolResult> }>,
    text: (message: string) => void,
    args: unknown,
  ) => Promise<void>;
  const execute = new Function(
    "tools",
    "text",
    "args",
    `"use strict"; return (async () => {\n${caller}\n})();`,
  ) as Caller;

  function start(call: () => Promise<ToolResult>) {
    const state = {
      calls: 0,
      outputs: [] as string[],
    };
    const promise = execute(
      { mcp__freecontext__gather_context: async () => { state.calls += 1; return call(); } },
      (message) => state.outputs.push(message),
      { taskText: "inspect" },
    );
    return { promise, state };
  }

  const fast = start(async () => ({
    content: [{ type: "text", text: "terminal" }, { type: "image" }],
    structuredContent: { status: "ready" },
    _meta: { private: true },
  }));
  await fast.promise;
  assert.equal(fast.state.calls, 1);
  assert.deepEqual(fast.state.outputs, ["terminal"]);

  const malformed = start(async () => ({
    content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
  }));
  await assert.rejects(malformed.promise, /no unique terminal text result/u);
  assert.deepEqual(malformed.state.outputs, []);
});
