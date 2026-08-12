import { randomUUID } from "node:crypto";
import { realpath, mkdir, open, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ConfigurationError,
  SecurityError,
  SessionPersistenceError,
} from "../errors.js";
import type { SessionPersistenceStage } from "../errors.js";

export interface SessionFileReservation {
  readonly path: string;
}

export interface CommittedSessionFile {
  readonly path: string;
  readonly bytes: number;
}

const reservations = new WeakMap<SessionFileReservation, FileHandle>();

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
  if (isWithin(workspace, directory)) {
    throw new SecurityError("Session files must be stored outside the explored workspace.");
  }
  const directoryStat = await stat(directory);
  if (!directoryStat.isDirectory()) throw new SecurityError(`Session destination is not a directory: ${directory}`);
  assertPrivateDirectory(directoryStat.mode, directory);

  const target = filePath
    ? path.join(directory, path.basename(path.resolve(filePath)))
    : path.join(directory, `${uuid()}.json`);
  if (path.extname(target).toLowerCase() !== ".json") {
    throw new ConfigurationError("Session file must end in .json.");
  }
  if (isWithin(workspace, target)) {
    throw new SecurityError("Session files must be stored outside the explored workspace.");
  }

  const handle = await open(target, "wx", 0o600);
  const reservation = Object.freeze({ path: target });
  reservations.set(reservation, handle);
  return reservation;
}

export async function commitSessionFile(
  reservation: Readonly<SessionFileReservation>,
  document: unknown,
): Promise<Readonly<CommittedSessionFile>> {
  const handle = reservations.get(reservation);
  if (!handle) throw new ConfigurationError("Session reservation is unknown or already committed.");
  reservations.delete(reservation);

  const rejectCommit = async (stage: SessionPersistenceStage, cause: unknown): Promise<never> => {
    const cleanupErrors: unknown[] = [];
    try {
      await handle.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await unlink(reservation.path);
    } catch (error) {
      if (!isNotFound(error)) cleanupErrors.push(error);
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
  try {
    await handle.writeFile(serialized, { encoding: "utf8" });
  } catch (error) {
    return rejectCommit("write", error);
  }
  try {
    await handle.sync();
  } catch (error) {
    return rejectCommit("sync", error);
  }
  try {
    await handle.close();
  } catch (error) {
    return rejectCommit("close", error);
  }
  return Object.freeze({ path: reservation.path, bytes: Buffer.byteLength(serialized) });
}
