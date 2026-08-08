import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createWorkspace, MAX_DIRECT_FILE_BYTES } from "../src/tools/workspace.js";
import { createRepositoryTools, detectToolExecutables } from "../src/tools/index.js";
import { FakeType, baseConfig } from "./helpers.js";

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-tools-"));
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src", "app.js"),
    ["export function target() {", "  return 'needle';", "}", "", "target();"].join("\n") + "\n",
    "utf8",
  );
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "node test.js" } }), "utf8");
  await writeFile(path.join(root, ".env"), "SECRET=hidden\n", "utf8");
  await writeFile(path.join(root, ".env.example"), "SECRET=\n", "utf8");
  return root;
}

function findTool(tools: readonly AgentTool[], name: string): AgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

function toolText(result: Awaited<ReturnType<AgentTool["execute"]>>): string {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("expected text tool output");
  return block.text;
}

test("read, rg, and glob expose bounded repository evidence", async () => {
  const root = await setup();
  try {
    const workspace = await createWorkspace(root);
    const toolset = await createRepositoryTools({ Type: FakeType, workspace, config: baseConfig() });

    const read = await findTool(toolset.tools, "read").execute("read-1", {
      path: "src/app.js",
      start_line: 1,
      end_line: 3,
    });
    assert.match(toolText(read), /1: export function target/u);
    assert.match(toolText(read), /3: \}/u);

    const envExample = await findTool(toolset.tools, "read").execute("read-env-example", {
      path: ".env.example",
      start_line: 1,
      end_line: 1,
    });
    assert.match(toolText(envExample), /SECRET=/u);

    const rg = await findTool(toolset.tools, "rg").execute("rg-1", {
      pattern: "target",
      path: ".",
      max_results: 20,
    });
    assert.match(toolText(rg), /src\/app\.js:1:/u);
    assert.match(toolText(rg), /src\/app\.js:5:/u);

    const glob = await findTool(toolset.tools, "glob").execute("glob-1", {
      pattern: ["**/*"],
      path: ".",
    });
    assert.match(toolText(glob), /src\/app\.js/u);
    assert.doesNotMatch(toolText(glob), /\.env\.example/u);
    assert.doesNotMatch(toolText(glob), /(^|\n)\.env($|\n)/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model globs cannot re-include protected files", async () => {
  const root = await setup();
  try {
    const workspace = await createWorkspace(root);
    const toolset = await createRepositoryTools({ Type: FakeType, workspace, config: baseConfig() });

    const glob = await findTool(toolset.tools, "glob").execute("glob-sensitive", {
      pattern: ["**/.env", "**/*"],
      path: ".",
    });
    assert.doesNotMatch(toolText(glob), /(^|\n)\.env($|\n)/u);

    const rg = await findTool(toolset.tools, "rg").execute("rg-sensitive", {
      pattern: "SECRET=hidden",
      path: ".",
      literal: true,
      glob: ["**/.env", "**/*"],
    });
    assert.match(toolText(rg), /<no matches>/u);
    assert.doesNotMatch(toolText(rg), /SECRET=hidden/u);

    const explicitSafeExample = await findTool(toolset.tools, "rg").execute("rg-safe-example", {
      pattern: "SECRET=",
      path: ".env.example",
      literal: true,
    });
    assert.match(toolText(explicitSafeExample), /\[rg path=\.env\.example\]\n1:1:/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model-controlled rg strings are argv data, not shell syntax", async () => {
  const root = await setup();
  try {
    const workspace = await createWorkspace(root);
    const toolset = await createRepositoryTools({ Type: FakeType, workspace, config: baseConfig() });
    const marker = path.join(root, "PWNED");
    await findTool(toolset.tools, "rg").execute("rg-injection", {
      pattern: "needle; touch PWNED",
      path: ".",
      literal: true,
    });
    assert.equal(await exists(marker), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("jq is constrained to one existing repository file when installed", async (t) => {
  const executables = await detectToolExecutables();
  if (!executables.jq) return t.skip("jq is not installed");
  const root = await setup();
  try {
    const workspace = await createWorkspace(root);
    const toolset = await createRepositoryTools({ Type: FakeType, workspace, config: baseConfig(), executables });
    const jq = findTool(toolset.tools, "jq");
    const result = await jq.execute("jq-1", { path: "package.json", filter: ".name", raw: true });
    assert.match(toolText(result), /\nfixture$/u);
    await assert.rejects(() => jq.execute("jq-2", { path: "../outside.json", filter: "." }), /escapes/u);
    await assert.rejects(
      () => jq.execute("jq-option-injection", { path: "package.json", filter: "--version" }),
      /compile error|version\/0 is not defined/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binary input is rejected by the native reader", async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    const workspace = await createWorkspace(root);
    const toolset = await createRepositoryTools({ Type: FakeType, workspace, config: baseConfig() });
    await assert.rejects(
      () => findTool(toolset.tools, "read").execute("read-bin", { path: "binary.bin" }),
      /Binary files are not supported/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct readers reject oversized files before reading content", async () => {
  const root = await setup();
  try {
    const largePath = path.join(root, "large.txt");
    const handle = await open(largePath, "w");
    try {
      await handle.truncate(MAX_DIRECT_FILE_BYTES + 1);
    } finally {
      await handle.close();
    }
    const workspace = await createWorkspace(root);
    const toolset = await createRepositoryTools({ Type: FakeType, workspace, config: baseConfig() });
    await assert.rejects(
      () => findTool(toolset.tools, "read").execute("read-large", { path: "large.txt" }),
      /safety limit/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository tools honor the context-aware output ceiling and keep truncation markers", async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, "wide.txt"), `${"x".repeat(500)}\n`, "utf8");
    const workspace = await createWorkspace(root);
    const toolset = await createRepositoryTools({
      Type: FakeType,
      workspace,
      config: baseConfig({ maxToolOutputBytes: 4096, effectiveToolOutputBytes: 64 }),
    });
    const result = await findTool(toolset.tools, "read").execute("read-wide", { path: "wide.txt" });
    assert.match(toolText(result), /<output truncated by byte limit>/u);
    assert.doesNotMatch(toolText(result), /x{100}/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
