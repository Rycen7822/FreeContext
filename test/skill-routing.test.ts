import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { FREECONTEXT_ELIGIBILITY_POLICY, FreeContextRequestSchema } from "../src/mcp/contracts.js";

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
    "For complex multi-file, multi-document, cross-module, long-document, or source-bound reads, the first tool cell must only read this SKILL.md—no pwd/rg/fd/Git/plan/catalog. The next cell directly calls tools.mcp__freecontext__gather_context.",
  );
  for (const gate of FREECONTEXT_ELIGIBILITY_POLICY.gates) assert.equal(skill.includes(gate.instruction), false);
  assert.match(skill, /First tool cell: read only this file/iu);
  assert.match(skill, /never append pwd, rg, fd, Git, plan, catalog, or repo actions/iu);
  for (const trigger of ["multi-file", "multi-document", "cross-module", "long-document", "source-bound"]) {
    assert.ok(description.includes(trigger));
  }
  assert.match(description, /first tool cell must only read this SKILL\.md—no pwd\/rg\/fd\/Git\/plan\/catalog/iu);
  assert.match(description, /next cell directly calls tools\.mcp__freecontext__gather_context/iu);
  assert.doesNotMatch(skill, /never auto-trigger|only (?:after )?an explicit user request/iu);
  assert.match(skill, /typeof tools\.mcp__freecontext__gather_context !== "function"/u);
  assert.doesNotMatch(skill, /ALL_TOOLS/u);
  assert.match(skill, /never inspect a tool catalog first/iu);
  assert.equal(skill.match(/await tools\.mcp__freecontext__gather_context\(args\)/gu)?.length, 1);
  assert.equal(skill.match(/\bnotify\(/gu)?.length, 1);
  assert.equal(skill.match(/functions\.wait/gu)?.length, 1);
  assert.match(skill, /yield_time_ms: 300000, max_tokens: 10000/u);
  assert.match(skill, /terminalTexts\.length !== 1/u);
  assert.doesNotMatch(skill, /JSON\.stringify/u);
  assert.match(skill, /FreeContext installs no waiting Hook/u);
  const requestExample = skill.match(/```json\n(?<json>\{[^\n]+\})\n```/u)?.groups?.json;
  assert.ok(requestExample);
  const exampleRequest = FreeContextRequestSchema.parse(JSON.parse(requestExample));
  assert.deepEqual(exampleRequest.evidenceQuestions.map(({ id, role, minimumSpans }) => ({ id, role, minimumSpans: minimumSpans ?? 1 })), [
    { id: "implementation", role: "implementation", minimumSpans: 2 },
    { id: "application", role: "caller", minimumSpans: 2 },
    { id: "contract", role: "contract", minimumSpans: 1 },
    { id: "tests", role: "test", minimumSpans: 1 },
  ]);
  assert.match(skill, /`knownRefs` \(`\[\]` when none\) accepts 0–12 path, symbol, or stack refs/u);
  assert.match(skill, /No identities, secrets, dumps, or query refs/u);
  assert.match(skill, /Code tasks use four required outcome questions/iu);
  assert.match(skill, /`minimumSpans` 2\/2\/1\/1/u);
  assert.match(skill, /not six shallow questions/iu);
  assert.match(skill, /Other tasks use 2–6 questions/iu);
  assert.match(skill, /Contract role requires a named API\/schema\/spec\/compatibility rule/iu);
  assert.doesNotMatch(skill, /\bworkspace_root\b/u);
  assert.throws(() => FreeContextRequestSchema.parse({
    ...exampleRequest,
    knownRefs: [{ kind: "query", query: "nosec" }],
  }));
  assert.match(skill, /Summaries are not reads/u);
  const sixQuestions = Array.from({ length: 6 }, (_, index) => ({
    id: `facet-${index}`,
    role: "implementation" as const,
    question: `Where is facet ${index}?`,
    required: true,
  }));
  assert.equal(FreeContextRequestSchema.safeParse({
    ...exampleRequest,
    evidenceQuestions: sixQuestions,
  }).success, true);
  assert.equal(FreeContextRequestSchema.safeParse({
    ...exampleRequest,
    evidenceQuestions: [...sixQuestions, { ...sixQuestions[0], id: "facet-6" }],
  }).success, false);
  assert.match(skill, /Next repository cell reads every Evidence range in one `Promise\.all` of literal `tools\.exec_command/iu);
  assert.match(skill, /no arrays\/maps, widening, or other action/iu);
  assert.match(skill, /Ready then edits directly/u);
  assert.match(skill, /For partial, call FreeContext once more for only the named gaps/iu);
  assert.match(skill, /never replay completed questions or broad-discover/iu);

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

test("caller template emits only one canonical text and one slow reminder", async () => {
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
    schedule: (callback: () => void, delayMs: number) => number,
    notify: (message: string) => void,
    text: (message: string) => void,
    cancel: (handle: number) => void,
    args: unknown,
  ) => Promise<void>;
  const execute = new Function(
    "tools",
    "setTimeout",
    "notify",
    "text",
    "clearTimeout",
    "args",
    `"use strict"; return (async () => {\n${caller}\n})();`,
  ) as Caller;

  function start(call: () => Promise<ToolResult>) {
    const state = {
      calls: 0,
      timers: [] as { callback: () => void; delayMs: number }[],
      notifications: [] as string[],
      outputs: [] as string[],
      cancelled: [] as number[],
    };
    const promise = execute(
      { mcp__freecontext__gather_context: async () => { state.calls += 1; return call(); } },
      (callback, delayMs) => { state.timers.push({ callback, delayMs }); return state.timers.length; },
      (message) => state.notifications.push(message),
      (message) => state.outputs.push(message),
      (handle) => state.cancelled.push(handle),
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
  assert.equal(fast.state.timers.length, 1);
  assert.equal(fast.state.timers[0]?.delayMs, 8_000);
  assert.deepEqual(fast.state.notifications, []);
  assert.deepEqual(fast.state.outputs, ["terminal"]);
  assert.deepEqual(fast.state.cancelled, [1]);

  let finishSlow!: (result: ToolResult) => void;
  const slowResult = new Promise<ToolResult>((resolve) => { finishSlow = resolve; });
  const slow = start(() => slowResult);
  await Promise.resolve();
  slow.state.timers[0]?.callback();
  finishSlow({ content: [{ type: "text", text: "slow terminal" }] });
  await slow.promise;
  assert.equal(slow.state.calls, 1);
  assert.equal(slow.state.notifications.length, 1);
  assert.deepEqual(slow.state.outputs, ["slow terminal"]);
  assert.deepEqual(slow.state.cancelled, [1]);

  const malformed = start(async () => ({
    content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
  }));
  await assert.rejects(malformed.promise, /no unique terminal text result/u);
  assert.deepEqual(malformed.state.outputs, []);
  assert.deepEqual(malformed.state.cancelled, [1]);
});
