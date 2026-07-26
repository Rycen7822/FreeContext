import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspace, isInside, isSensitiveRelativePath } from "../src/tools/workspace.mjs";

async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "freecontext-workspace-"));
  const root = path.join(parent, "repo");
  await mkdir(root);
  await writeFile(path.join(root, "source.txt"), "hello\n", "utf8");
  await writeFile(path.join(root, ".env"), "SECRET=x\n", "utf8");
  await writeFile(path.join(root, ".env.example"), "SECRET=\n", "utf8");
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, ".git", "config"), "unsafe\n", "utf8");
  const outside = path.join(parent, "outside.txt");
  await writeFile(outside, "outside\n", "utf8");
  return { parent, root, outside };
}

test("workspace confines lexical paths and allows normal files", async () => {
  const { parent, root } = await fixture();
  try {
    const workspace = await createWorkspace(root);
    const source = await workspace.resolveExisting("source.txt", { kind: "file" });
    assert.equal(source.relative, "source.txt");
    await assert.rejects(() => workspace.resolveExisting("../outside.txt"), /escapes the workspace/u);
    assert.equal(isInside(workspace.root, source.absolute), true);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("workspace blocks credentials while allowing examples", async () => {
  const { parent, root } = await fixture();
  try {
    const workspace = await createWorkspace(root);
    await assert.rejects(() => workspace.resolveExisting(".env", { kind: "file" }), /sensitive/u);
    await assert.rejects(() => workspace.resolveExisting(".git/config", { kind: "file" }), /sensitive/u);
    const example = await workspace.resolveExisting(".env.example", { kind: "file" });
    assert.equal(example.relative, ".env.example");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("workspace rejects symlink escape", async (t) => {
  if (process.platform === "win32") return t.skip("symlink permissions vary on Windows");
  const { parent, root, outside } = await fixture();
  try {
    await symlink(outside, path.join(root, "escape.txt"));
    const workspace = await createWorkspace(root);
    await assert.rejects(() => workspace.resolveExisting("escape.txt", { kind: "file" }), /Resolved path escapes/u);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("sensitive-name classifier covers private material", () => {
  assert.equal(isSensitiveRelativePath("nested/id_ed25519"), true);
  assert.equal(isSensitiveRelativePath("certs/server.pem"), true);
  assert.equal(isSensitiveRelativePath("config/.env.production"), true);
  assert.equal(isSensitiveRelativePath("config/.env.example"), false);
  assert.equal(isSensitiveRelativePath("config/production.env"), true);
  assert.equal(isSensitiveRelativePath("config/settings.example.env"), false);
  assert.equal(isSensitiveRelativePath(".aws/credentials"), true);
  assert.equal(isSensitiveRelativePath("src/index.ts"), false);
});
