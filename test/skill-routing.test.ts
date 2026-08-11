import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("FreeContext skill routes broad reading to one atomic MCP tool", async () => {
  const [skill, metadata] = await Promise.all([
    readFile(new URL("../skills/freecontext/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../skills/freecontext/agents/openai.yaml", import.meta.url), "utf8"),
  ]);

  const description = skill.match(
    /^---\nname: freecontext\ndescription: (?<description>[^\n]+)\n---\n/u,
  )?.groups?.description;
  assert.ok(description);
  assert.ok(Buffer.byteLength(skill, "utf8") <= 1_800);
  assert.ok([...description].length <= 420);
  assert.match(description, /After loading, call FreeContext next before parent discovery; never batch its read\./u);

  for (const trigger of [
    "multi-file code/workspace exploration",
    "cross-document keyword/topic search",
    "long-document fact extraction",
    "source-bound planning/review/diagnosis",
    "including familiar repositories and known candidate files",
    "task spans files, documents, evidence classes, or long-document sections",
  ]) {
    assert.ok(skill.includes(trigger), `missing routing trigger: ${trigger}`);
  }
  assert.match(skill, /call `gather_context` once/u);
  assert.match(
    skill,
    /Read this skill alone: never batch that read with Git, file listing, search, source\/document reads, or other task work\. Make `gather_context` the next tool action/u,
  );
  assert.match(skill, /mcp__freecontext__gather_context.*ALL_TOOLS.*same `functions\.exec` call/u);
  assert.match(skill, /forward its result to the parent without listing the full catalog/u);
  assert.match(skill, /exact argument keys `query`.*`workspace`/u);
  assert.doesNotMatch(skill, /\bworkspace_root\b/u);
  assert.match(skill, /one bounded read\/search in one known target fully answers/u);
  assert.match(skill, /read only decisive\/edit ranges/u);
  assert.match(skill, /Call again only for a material gap named by the result/u);

  assert.match(metadata, /^  allow_implicit_invocation: true$/mu);
  assert.equal(metadata.match(/^    - type:/gmu)?.length, 1);
  assert.match(metadata, /^    - type: "mcp"$/mu);
  assert.equal(metadata.match(/^      value: "freecontext"$/gmu)?.length, 1);
  const shortDescription = metadata.match(/^  short_description: "([^"]+)"$/mu)?.[1];
  assert.ok(shortDescription);
  assert.ok(shortDescription.length >= 25 && shortDescription.length <= 64);

  const routingSurface = `${skill}\n${metadata}`;
  for (const forbidden of [
    /freecontext explore/u,
    /_GUIDANCE/u,
    /\b(?:shell|poll(?:ing)?|wait)\b/iu,
    /\bexplore_repository\b/u,
    /default_prompt:/u,
    /https?:\/\//u,
    /Manual compatibility command/u,
    /\b(?:TOKENRHYTHM|API_KEY|base_url|bearer)\b/u,
    /\b(?:provider|model|credentials?)\s*[:=]/iu,
    /\b(?:DeepSWE|TaskNameXXX|returns-validated|mashumaro)\b/u,
  ]) {
    assert.doesNotMatch(routingSurface, forbidden);
  }
});
