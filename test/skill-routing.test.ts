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
    "Route complex reads through FreeContext. For multi-file, multi-document, cross-module, long-document, or source-bound work, open this skill alone before repository read/search, then call gather_context first.",
  );
  for (const gate of FREECONTEXT_ELIGIBILITY_POLICY.gates) assert.equal(skill.includes(gate.instruction), false);
  assert.match(skill, /first and only `functions\.exec`/u);
  for (const trigger of ["multi-file", "multi-document", "cross-module", "long-document", "source-bound"]) {
    assert.ok(description.includes(trigger));
  }
  assert.match(description, /open this skill alone before repository read\/search, then call gather_context first/u);
  assert.doesNotMatch(skill, /never auto-trigger|only (?:after )?an explicit user request/iu);
  assert.match(skill, /typeof tools\.mcp__freecontext__gather_context !== "function"/u);
  assert.doesNotMatch(skill, /ALL_TOOLS/u);
  assert.match(skill, /never query catalogs/u);
  assert.equal(skill.match(/await tools\.mcp__freecontext__gather_context\(args\)/gu)?.length, 1);
  assert.equal(skill.match(/\bnotify\(/gu)?.length, 1);
  assert.equal(skill.match(/functions\.wait/gu)?.length, 1);
  assert.match(skill, /yield_time_ms: 300000, max_tokens: 10000/u);
  assert.match(skill, /terminalTexts\.length !== 1/u);
  assert.doesNotMatch(skill, /JSON\.stringify/u);
  assert.match(skill, /FreeContext installs no waiting Hook/u);
  const requestExample = skill.match(/```json\n(?<json>\{[^\n]+\})\n```/u)?.groups?.json;
  assert.ok(requestExample);
  assert.doesNotThrow(() => FreeContextRequestSchema.parse(JSON.parse(requestExample)));
  assert.match(skill, /Include `knownRefs` \(`\[\]` when none\): 0–12/u);
  for (const shape of ['{kind:"path",path}', '{kind:"symbol",symbol,path?}', '{kind:"stack",path,line}']) {
    assert.ok(skill.includes(shape));
  }
  assert.match(skill, /no query refs/u);
  assert.match(skill, /use 2–5 unique ids/iu);
  assert.match(skill, /`implementation`, `caller`, `test`, or `contract`/u);
  assert.match(skill, /contract requires a distinct existing repository source, not requested new behavior/u);
  assert.doesNotMatch(skill, /\bworkspace_root\b/u);
  assert.throws(() => FreeContextRequestSchema.parse({
    ...JSON.parse(requestExample),
    knownRefs: [{ kind: "query", query: "nosec" }],
  }));
  assert.match(skill, /Summaries are not reads/u);
  assert.match(skill, /Next repository cell: evidence reads only, including `nextAction`/u);
  assert.match(skill, /no plan, branch, status, or search/u);
  assert.match(skill, /partial gets one targeted named-gap search batch; ready none/u);
  assert.match(skill, /Never use broad discovery or replay/u);

  assert.match(metadata, /^  allow_implicit_invocation: true$/mu);
  assert.equal(metadata.match(/^    - type:/gmu)?.length, 1);
  assert.match(metadata, /^    - type: "mcp"$/mu);
  assert.equal(metadata.match(/^      value: "freecontext"$/gmu)?.length, 1);
  const shortDescription = metadata.match(/^  short_description: "([^"]+)"$/mu)?.[1];
  assert.equal(shortDescription, "Open FreeContext before complex reads");
  assert.doesNotMatch(skill, /After loading, call FreeContext next/u);

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
