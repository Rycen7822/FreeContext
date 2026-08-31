import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { FREECONTEXT_ELIGIBILITY_POLICY, FreeContextCallerRequestSchema } from "../src/mcp/contracts.js";

test("implicit discovery routes each current gap while preserving the atomic caller contract", async () => {
  const [skill, metadata] = await Promise.all([
    readFile(new URL("../skills/freecontext/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../skills/freecontext/agents/openai.yaml", import.meta.url), "utf8"),
  ]);

  const description = skill.match(
    /^---\nname: freecontext\ndescription: (?<description>[^\n]+)\n---\n/u,
  )?.groups?.description;
  assert.ok(description);
  assert.ok(Buffer.byteLength(skill, "utf8") <= 5_400);
  assert.ok([...description].length <= 420);
  for (const gate of FREECONTEXT_ELIGIBILITY_POLICY.gates) assert.equal(skill.includes(gate.instruction), false);
  for (const trigger of ["current evidence gap", "cross-module", "multi-role", "long-document", "source-bound"]) {
    assert.ok(description.includes(trigger));
  }
  assert.match(description, /Use initially or after Evidence, an edit, or a check/iu);
  assert.match(description, /exact path.*changed hunk.*diff or status.*test.*exact failure location/iu);
  assert.doesNotMatch(skill, /call FC before native work|at task start|first read-only exploration action/iu);
  assert.match(skill, /```js\n\/\/ @exec: \{"yield_time_ms": 300000, "max_output_tokens": 10000\}/u);
  const codeStart = skill.indexOf("```js\n");
  const pragma = skill.indexOf("// @exec: {\"yield_time_ms\": 300000, \"max_output_tokens\": 10000}");
  const argsCue = skill.indexOf("// Construct documented args here.");
  const gatherCall = skill.indexOf("const result = await tools.mcp__freecontext__gather_context(args);");
  assert.equal(pragma, codeStart + "```js\n".length);
  assert.ok(pragma < argsCue && argsCue < gatherCall);
  assert.match(skill, /gather_context` alone/u);
  assert.match(skill, /Never parallelize or batch/u);
  assert.match(skill, /do other work during dispatch/u);
  assert.match(skill, /typeof tools\.mcp__freecontext__gather_context !== "function"/u);
  assert.doesNotMatch(skill, /ALL_TOOLS/u);
  assert.equal(skill.match(/await tools\.mcp__freecontext__gather_context\(args\)/gu)?.length, 1);
  assert.equal(skill.match(/\bnotify\(/gu)?.length ?? 0, 0);
  assert.equal(skill.match(/functions\.wait/gu)?.length, 1);
  assert.match(skill, /yield_time_ms: ?300000, ?max_tokens: ?10000/u);
  assert.match(skill, /terminalTexts\.length !== 1/u);
  assert.doesNotMatch(skill, /JSON\.stringify/u);
  assert.match(skill, /No waiting Hook/u);
  const template = skill.match(/`(?<template>const args=\{[\s\S]+?\};)`/u)?.groups?.template;
  assert.ok(template);
  const templateArgs = runInNewContext(`${template}\nargs`, Object.create(null), { timeout: 100 });
  const parsedTemplate = FreeContextCallerRequestSchema.parse(templateArgs);
  assert.equal(parsedTemplate.workUnit.outcome, "edit");
  assert.match(parsedTemplate.workUnit.goal, /conditional routing/iu);
  assert.equal(parsedTemplate.evidenceQuestions.length, 1);
  assert.equal(parsedTemplate.evidenceQuestions[0]?.role, "implementation");
  assert.equal(parsedTemplate.evidenceQuestions[0]?.required, true);
  assert.equal(parsedTemplate.evidenceQuestions[0]?.target, undefined);
  assert.match(skill, /Roles are only `implementation`, `caller`, `test`, or `contract`/u);
  assert.match(skill, /question becomes a topic target.*`required:true`.*role-appropriate `factKind`.*stable id.*`single` coverage default internally/u);
  assert.match(skill, /`knownRefs` are/u);
  assert.match(skill, /stable outer implementation goal/u);
  assert.doesNotMatch(skill, /\bworkspace_root\b/u);
  assert.match(skill, /A listed partial gap is not permission to replay/iu);
  assert.match(skill, /ordinary edit\/check\/read\/diff work stays direct/iu);
  assert.match(skill, /After an edit or failed check, use a diagnostic checkpoint/iu);
  assert.match(skill, /at most one direct read of the exact failure location is allowed/iu);
  assert.match(skill, /Before a second non-adjacent file read or cross-module search for that diagnosis, stop and classify the remaining gap/iu);
  assert.match(skill, /distinct new static cross-module relationship not covered by the prior handoff/iu);
  for (const nativeCase of ["Single-file work", "exact failures", "routine checks", "same handoff gap"]) {
    assert.match(skill, new RegExp(`${nativeCase}.*remain native`, "iu"));
  }
  assert.match(skill, /Never force a second call/iu);
  assert.match(skill, /Copy `priorHandoff` verbatim/iu);
  assert.match(skill, /keep `workUnit` exactly equal/iu);
  for (const origin of ["evidence_consumption", "edit", "check"]) assert.match(skill, new RegExp(`(?:${origin})`, "u"));
  assert.match(skill, /questionId,targetId,kind,scope,requiredFact,derivation,origin/iu);
  assert.match(skill, /Never target a changed path or exact failure path/iu);
  assert.match(skill, /Recovery is once-only/iu);
  assert.doesNotMatch(skill, /complete unresolved question|same-unit|same gaps|Acceptance receipt|private acceptance receipt/iu);

  assert.match(metadata, /^  allow_implicit_invocation: true$/mu);
  assert.equal(metadata.match(/^    - type:/gmu)?.length, 1);
  assert.match(metadata, /^    - type: "mcp"$/mu);
  assert.equal(metadata.match(/^      value: "freecontext"$/gmu)?.length, 1);
  const shortDescription = metadata.match(/^  short_description: "([^"]+)"$/mu)?.[1];
  assert.ok(shortDescription);
  assert.ok([...shortDescription].length >= 25 && [...shortDescription].length <= 64);
  assert.match(shortDescription, /current evidence gaps/iu);
  assert.doesNotMatch(shortDescription, /first|next/iu);

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
