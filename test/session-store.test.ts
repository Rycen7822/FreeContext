import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SecurityError } from "../src/errors.js";
import { commitSessionFile, reserveSessionFile } from "../src/session/store.js";

test("session store reserves and commits one private parseable file outside the workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-store-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(root, "state", "sessions");
  try {
    await mkdir(workspace);
    const reservation = await reserveSessionFile({
      workspaceRoot: workspace,
      sessionDirectory: sessions,
      uuid: () => "00000000-0000-4000-8000-000000000001",
    });
    assert.equal(reservation.path, path.join(sessions, "00000000-0000-4000-8000-000000000001.json"));
    assert.equal((await stat(sessions)).mode & 0o777, 0o700);
    assert.equal((await stat(reservation.path)).mode & 0o777, 0o600);

    const document = { status: "failed", error: { code: "PROVIDER_ERROR", message: "unavailable" } };
    assert.equal(await commitSessionFile(reservation, document), reservation.path);
    assert.deepEqual(JSON.parse(await readFile(reservation.path, "utf8")), document);
    await assert.rejects(commitSessionFile(reservation, document), /already committed/u);
    await assert.rejects(
      reserveSessionFile({
        workspaceRoot: workspace,
        sessionDirectory: sessions,
        uuid: () => "00000000-0000-4000-8000-000000000001",
      }),
      /EEXIST/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session store rejects workspace and insecure existing destinations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-store-"));
  const workspace = path.join(root, "workspace");
  const insecure = path.join(root, "insecure");
  try {
    await Promise.all([mkdir(workspace), mkdir(insecure)]);
    await chmod(insecure, 0o755);
    await assert.rejects(
      reserveSessionFile({ workspaceRoot: workspace, sessionDirectory: path.join(workspace, "sessions") }),
      (error: unknown) => error instanceof SecurityError,
    );
    await assert.rejects(
      reserveSessionFile({ workspaceRoot: workspace, sessionDirectory: insecure }),
      (error: unknown) => error instanceof SecurityError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
