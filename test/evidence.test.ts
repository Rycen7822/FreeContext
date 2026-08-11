import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseFinalBlock, renderFinalAnswer, validateExplorerOutput } from "../src/output/evidence.js";
import { createWorkspace } from "../src/tools/workspace.js";

const VALID = `<final_answer>
summary: The implementation is in the sample module.
evidence:
- sample.js:1-2 — Defines and returns the value.
gaps:
- none
</final_answer>`;

test("parseFinalBlock extracts the last valid-shaped block", () => {
  const parsed = parseFinalBlock(`noise\n${VALID}`);
  assert.equal(parsed.summary, "The implementation is in the sample module.");
  assert.deepEqual(parsed.evidence[0], {
    path: "sample.js",
    start: 1,
    end: 2,
    reason: "Defines and returns the value.",
  });
});

test("parser expands explicit comma-separated ranges for one path", () => {
  const parsed = parseFinalBlock(VALID.replace("sample.js:1-2", "sample.js:1, 2-2"));
  assert.deepEqual(
    parsed.evidence.map(({ path, start, end }) => ({ path, start, end })),
    [
      { path: "sample.js", start: 1, end: 1 },
      { path: "sample.js", start: 2, end: 2 },
    ],
  );
  assert.deepEqual(parsed.problems, []);
});

test("validator confirms paths and real line ranges", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freecontext-evidence-"));
  try {
    await writeFile(path.join(directory, "sample.js"), "const x = 1;\nexport { x };\n", "utf8");
    const workspace = await createWorkspace(directory);
    const result = await validateExplorerOutput(VALID, workspace);
    assert.equal(result.valid, true);
    assert.equal(renderFinalAnswer(result), VALID);

    const invalid = await validateExplorerOutput(VALID.replace("1-2", "1-8"), workspace);
    assert.equal(invalid.valid, false);
    assert.match(invalid.problems.join("\n"), /exceeds file length/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("validator preserves 27 valid citations when one citation is malformed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freecontext-evidence-"));
  try {
    const source = Array.from({ length: 27 }, (_, index) => `line ${index + 1}`).join("\n");
    await writeFile(path.join(directory, "sample.js"), `${source}\n`, "utf8");
    const citations = Array.from(
      { length: 27 },
      (_, index) => `- sample.js:${index + 1}-${index + 1} — Evidence ${index + 1}.`,
    );
    const output = `<final_answer>
summary: Twenty-seven lines are supported.
evidence:
${citations.join("\n")}
- fabricated-secret.txt has no valid citation range
gaps:
- none
</final_answer>`;
    const result = await validateExplorerOutput(output, await createWorkspace(directory));

    assert.equal(result.status, "partial");
    assert.equal(result.valid, true);
    assert.equal(result.evidence.length, 27);
    assert.deepEqual(result.gaps, ["Validation: Malformed evidence citation."]);
    assert.deepEqual(result.problems, ["Malformed evidence citation."]);
    assert.doesNotMatch(renderFinalAnswer(result), /fabricated-secret/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("validator rejects fabricated and sensitive paths", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freecontext-evidence-"));
  try {
    await writeFile(path.join(directory, ".env"), "TOKEN=x\n", "utf8");
    const workspace = await createWorkspace(directory);
    const result = await validateExplorerOutput(
      VALID.replace("sample.js:1-2", ".env:1-1"),
      workspace,
    );
    assert.equal(result.valid, false);
    assert.match(result.problems.join("\n"), /sensitive/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("parser reports malformed output instead of accepting prose", () => {
  const parsed = parseFinalBlock("The answer is src/a.js");
  assert.deepEqual(parsed.problems, ["Missing <final_answer> block."]);
});
