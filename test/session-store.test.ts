import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SecurityError, SessionPersistenceError } from "../src/errors.js";
import { cancelSessionFile, commitSessionFile, reserveSessionFile } from "../src/session/store.js";

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
    await assert.rejects(stat(reservation.path), /ENOENT/u);
    const pending = await readdir(sessions);
    assert.equal(pending.length, 2);
    assert.ok(pending.every((name) => name.startsWith(".") && (name.endsWith(".tmp") || name.endsWith(".lock"))));
    for (const name of pending) assert.equal((await stat(path.join(sessions, name))).mode & 0o777, 0o600);

    const payload = { status: "failed", error: { code: "PROVIDER_ERROR", message: "unavailable" } };
    let serializations = 0;
    const document = {
      toJSON: () => {
        serializations += 1;
        return payload;
      },
    };
    const committed = await commitSessionFile(reservation, document);
    const raw = await readFile(reservation.path, "utf8");
    assert.deepEqual(committed, {
      path: reservation.path,
      bytes: Buffer.byteLength(raw),
      sha256: createHash("sha256").update(raw).digest("hex"),
    });
    assert.equal(serializations, 1);
    assert.deepEqual(JSON.parse(raw), payload);
    assert.deepEqual(await readdir(sessions), [path.basename(reservation.path)]);
    await assert.rejects(commitSessionFile(reservation, document), /already committed/u);
    await assert.rejects(
      reserveSessionFile({
        workspaceRoot: workspace,
        sessionDirectory: sessions,
        uuid: () => "00000000-0000-4000-8000-000000000001",
      }),
      (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelled reservations leave no final, temp, or lock file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-store-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(root, "state", "sessions");
  try {
    await mkdir(workspace);
    const reservation = await reserveSessionFile({
      workspaceRoot: workspace,
      sessionDirectory: sessions,
      uuid: () => "00000000-0000-4000-8000-000000000099",
    });
    await cancelSessionFile(reservation);
    assert.deepEqual(await readdir(sessions), []);
    await assert.rejects(commitSessionFile(reservation, { status: "late" }), /already committed/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session store removes reservations whose documents cannot be serialized", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-store-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(root, "state", "sessions");
  try {
    await mkdir(workspace);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const fixtures: readonly unknown[] = [circular, { value: 1n }, undefined];
    for (const [index, fixture] of fixtures.entries()) {
      const reservation = await reserveSessionFile({
        workspaceRoot: workspace,
        sessionDirectory: sessions,
        uuid: () => `00000000-0000-4000-8000-00000000000${index + 2}`,
      });
      await assert.rejects(
        commitSessionFile(reservation, fixture),
        (error: unknown) => error instanceof SessionPersistenceError && error.stage === "serialize",
      );
      await assert.rejects(stat(reservation.path), /ENOENT/u);
      await assert.rejects(commitSessionFile(reservation, fixture), /already committed/u);
    }
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
