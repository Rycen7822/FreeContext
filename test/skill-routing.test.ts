import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { FREECONTEXT_ELIGIBILITY_POLICY, FreeContextCallerFullRequestSchema, FreeContextCallerRequestSchema } from "../src/mcp/contracts.js";

test("skill routes only concrete exploration gaps and preserves the atomic caller contract", async () => {
  const [skill, metadata] = await Promise.all([
    readFile(new URL("../skills/freecontext/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../skills/freecontext/agents/openai.yaml", import.meta.url), "utf8"),
  ]);
  const description = skill.match(/^---\nname: freecontext\ndescription: (?<description>[^\n]+)\n---\n/u)?.groups?.description;
  assert.ok(description);
  assert.ok(Buffer.byteLength(skill, "utf8") <= 5_400);
  assert.ok([...description].length <= 560);
  for (const gate of FREECONTEXT_ELIGIBILITY_POLICY.gates) assert.equal(skill.includes(gate.instruction), false);
  assert.match(description, /concrete next multi-file or multi-relation evidence gap/iu);
  assert.match(description, /Exact paths.*symbols.*failures.*one bounded read.*diff or status.*edits.*tests.*direct checks stay native/iu);
  assert.match(skill, /Do not call because a task starts, a phase changes, the task looks complex, or a probability threshold/iu);
  assert.match(skill, /Known references are optional priority hints, never a gate/iu);
  assert.match(skill, /reconsider only if it exposes a new cross-file evidence question/iu);
  assert.match(skill, /Evidence-origin reentry is only for an independent child/iu);
  assert.match(skill, /```js\n\/\/ @exec: \{"yield_time_ms": 300000, "max_output_tokens": 10000\}/u);
  assert.match(skill, /gather_context` alone/u);
  assert.match(skill, /Never parallelize it or do other work during dispatch/u);
  assert.match(skill, /functions\.wait/gu);
  assert.doesNotMatch(skill, /whole-phase|roughly 30%|next step may|second non-adjacent|knownRef-first/iu);
  assert.doesNotMatch(skill, /knownRefs\s*:/u);
  assert.doesNotMatch(skill, /target\s*:/u);
  const caller = skill.match(/```js\n(?<code>[\s\S]+?)\n```/u)?.groups?.code;
  assert.ok(caller);
  const template = caller.match(/const args\s*=\s*(\{[\s\S]+?\});/u)?.[1];
  assert.ok(template);
  const templateArgs = runInNewContext(`(${template})`, Object.create(null), { timeout: 100 });
  FreeContextCallerRequestSchema.parse(templateArgs);
  const parsedTemplate = FreeContextCallerFullRequestSchema.parse(templateArgs);
  assert.equal(parsedTemplate.workUnit.outcome, "edit");
  assert.equal(parsedTemplate.evidenceQuestions.length, 1);
  assert.equal(parsedTemplate.evidenceQuestions[0]?.role, "implementation");
  assert.equal(parsedTemplate.evidenceQuestions[0]?.target, undefined);

  assert.match(metadata, /^  allow_implicit_invocation: true$/mu);
  const shortDescription = metadata.match(/^  short_description: "([^"]+)"$/mu)?.[1];
  assert.ok(shortDescription);
  assert.ok([...shortDescription].length >= 25 && [...shortDescription].length <= 64);
  assert.match(shortDescription, /concrete|multi-file|evidence/iu);
  assert.doesNotMatch(`${skill}\n${metadata}`, /https?:\/\/|base_url|API_KEY|bearer|DeepSWE|whole-phase|knownRef-first/iu);
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
    const state = { calls: 0, outputs: [] as string[] };
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
