import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigurationError, SecurityError, SessionPersistenceError } from "../errors.js";
import type { SessionPersistenceStage } from "../errors.js";

export interface SessionFileReservation {
  readonly path: string;
}

export interface CommittedSessionFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface ReservationState {
  readonly handle: FileHandle;
  readonly lockHandle: FileHandle;
  readonly temporaryPath: string;
  readonly lockPath: string;
  readonly directory: string;
}

const reservations = new WeakMap<SessionFileReservation, ReservationState>();

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function resolveProspectivePath(target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;
  while (true) {
    try {
      const resolved = await realpath(current);
      return path.join(resolved, ...missing.reverse());
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function assertPrivateDirectory(mode: number, directory: string): void {
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    throw new SecurityError(`Session directory must not be accessible by group or other users: ${directory}`);
  }
}

function existsError(target: string): Error {
  return Object.assign(new Error(`Session file already exists: ${target}`), { code: "EEXIST" });
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function unlinkIfPresent(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function cleanupReservation(state: ReservationState): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const close of [() => state.handle.close(), () => state.lockHandle.close()]) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  for (const target of [state.temporaryPath, state.lockPath]) {
    try { await unlinkIfPresent(target); } catch (error) { errors.push(error); }
  }
  return errors;
}

export function defaultSessionDirectory(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  const configured = env.XDG_STATE_HOME?.trim();
  if (configured && !path.isAbsolute(configured)) {
    throw new ConfigurationError("XDG_STATE_HOME must be an absolute path when set.");
  }
  return path.join(configured || path.join(homeDirectory, ".local", "state"), "freecontext", "sessions");
}

export async function reserveSessionFile({
  workspaceRoot,
  sessionDirectory,
  filePath,
  uuid = randomUUID,
}: Readonly<{
  workspaceRoot: string;
  sessionDirectory?: string;
  filePath?: string;
  uuid?: () => string;
}>): Promise<Readonly<SessionFileReservation>> {
  if (Boolean(sessionDirectory) === Boolean(filePath)) {
    throw new ConfigurationError("Provide exactly one sessionDirectory or filePath.");
  }
  const workspace = await realpath(workspaceRoot);
  const requestedDirectory = path.resolve(sessionDirectory || path.dirname(filePath as string));
  const prospectiveDirectory = await resolveProspectivePath(requestedDirectory);
  if (isWithin(workspace, prospectiveDirectory)) {
    throw new SecurityError("Session files must be stored outside the explored workspace.");
  }
  if (sessionDirectory) await mkdir(requestedDirectory, { recursive: true, mode: 0o700 });
  const directory = await realpath(requestedDirectory);
  if (isWithin(workspace, directory)) throw new SecurityError("Session files must be stored outside the explored workspace.");
  const directoryStat = await stat(directory);
  if (!directoryStat.isDirectory()) throw new SecurityError(`Session destination is not a directory: ${directory}`);
  assertPrivateDirectory(directoryStat.mode, directory);

  const identity = uuid();
  const target = filePath
    ? path.join(directory, path.basename(path.resolve(filePath)))
    : path.join(directory, `${identity}.json`);
  if (path.extname(target).toLowerCase() !== ".json") throw new ConfigurationError("Session file must end in .json.");
  if (isWithin(workspace, target)) throw new SecurityError("Session files must be stored outside the explored workspace.");
  if (await pathExists(target)) throw existsError(target);

  const lockPath = path.join(directory, `.${path.basename(target)}.lock`);
  const temporaryPath = path.join(directory, `.${path.basename(target)}.${identity}.tmp`);
  let lockHandle: FileHandle | null = null;
  let handle: FileHandle | null = null;
  try {
    lockHandle = await open(lockPath, "wx", 0o600);
    handle = await open(temporaryPath, "wx", 0o600);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    if (lockHandle) await lockHandle.close().catch(() => undefined);
    await unlinkIfPresent(temporaryPath).catch(() => undefined);
    await unlinkIfPresent(lockPath).catch(() => undefined);
    throw error;
  }
  const reservation = Object.freeze({ path: target });
  reservations.set(reservation, { handle, lockHandle, temporaryPath, lockPath, directory });
  return reservation;
}

export async function cancelSessionFile(reservation: Readonly<SessionFileReservation>): Promise<void> {
  const state = reservations.get(reservation);
  if (!state) return;
  reservations.delete(reservation);
  const errors = await cleanupReservation(state);
  if (errors.length > 0) throw new SessionPersistenceError("close", { cause: new AggregateError(errors) });
}

export async function commitSessionFile(
  reservation: Readonly<SessionFileReservation>,
  document: unknown,
): Promise<Readonly<CommittedSessionFile>> {
  const state = reservations.get(reservation);
  if (!state) throw new ConfigurationError("Session reservation is unknown or already committed.");
  reservations.delete(reservation);
  let renamed = false;

  const rejectCommit = async (stage: SessionPersistenceStage, cause: unknown): Promise<never> => {
    const cleanupErrors = await cleanupReservation(state);
    if (renamed) {
      try { await unlinkIfPresent(reservation.path); } catch (error) { cleanupErrors.push(error); }
    }
    const errorCause = cleanupErrors.length > 0
      ? new AggregateError([cause, ...cleanupErrors], "Session commit and cleanup failed.")
      : cause;
    throw new SessionPersistenceError(stage, { cause: errorCause });
  };

  let serialized: string;
  try {
    const json = JSON.stringify(document, null, 2);
    if (json === undefined) throw new TypeError("Session document is not JSON-serializable.");
    serialized = `${json}\n`;
  } catch (error) {
    return rejectCommit("serialize", error);
  }
  try { await state.handle.writeFile(serialized, { encoding: "utf8" }); } catch (error) { return rejectCommit("write", error); }
  try { await state.handle.sync(); } catch (error) { return rejectCommit("sync", error); }
  try { await state.handle.close(); } catch (error) { return rejectCommit("close", error); }
  try {
    if (await pathExists(reservation.path)) throw existsError(reservation.path);
    await rename(state.temporaryPath, reservation.path);
    renamed = true;
  } catch (error) {
    return rejectCommit("rename", error);
  }
  try {
    await state.lockHandle.close();
    await unlinkIfPresent(state.lockPath);
    const directoryHandle = await open(state.directory, fsConstants.O_RDONLY);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (error) {
    return rejectCommit("directory_sync", error);
  }
  return Object.freeze({
    path: reservation.path,
    bytes: Buffer.byteLength(serialized),
    sha256: createHash("sha256").update(serialized).digest("hex"),
  });
}
