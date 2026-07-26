import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { SecurityError } from "../errors.mjs";

const BLOCKED_BASENAMES = new Set([
  ".env",
  ".envrc",
  ".dev.vars",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
  "credentials.json",
  "secrets.json",
  "secrets.toml",
  "secrets.yaml",
  "secrets.yml",
  "service-account.json",
]);

const BLOCKED_SUFFIXES = [".pem", ".p12", ".pfx", ".key", ".keystore"];
const BLOCKED_SEGMENTS = new Set([".git", ".ssh", ".gnupg", ".aws", ".azure", ".kube"]);

export const MAX_DIRECT_FILE_BYTES = 32 * 1024 * 1024;

function toPosix(value) {
  return value.split(path.sep).join("/");
}

export function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function isSensitiveRelativePath(relativePath) {
  const normalized = toPosix(relativePath).replace(/^\.\//u, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => BLOCKED_SEGMENTS.has(segment.toLowerCase()))) return true;
  const basename = segments.at(-1)?.toLowerCase() || "";
  if (BLOCKED_BASENAMES.has(basename)) return true;
  if (basename.endsWith(".env") && !basename.endsWith(".example.env")) return true;
  if (basename.startsWith(".env.") && !basename.endsWith(".example")) return true;
  if (BLOCKED_SUFFIXES.some((suffix) => basename.endsWith(suffix))) return true;
  return false;
}

export function assertDirectFileSize(target, maxBytes = MAX_DIRECT_FILE_BYTES) {
  if (!target?.stat?.isFile?.()) throw new SecurityError("Direct file access requires a regular file.");
  if (target.stat.size > maxBytes) {
    throw new SecurityError(
      `Direct file access exceeds the ${maxBytes}-byte safety limit: ${target.relative} (${target.stat.size} bytes)`,
    );
  }
}

export async function createWorkspace(rootInput) {
  const requestedRoot = path.resolve(rootInput || process.cwd());
  let root;
  try {
    root = await realpath(requestedRoot);
  } catch (error) {
    throw new SecurityError(`Workspace does not exist or cannot be resolved: ${requestedRoot}`, { cause: error });
  }
  const metadata = await stat(root);
  if (!metadata.isDirectory()) throw new SecurityError(`Workspace is not a directory: ${root}`);

  async function resolveExisting(input = ".", { kind = "any", allowSensitive = false } = {}) {
    if (typeof input !== "string" || input.includes("\0")) {
      throw new SecurityError("Path must be a valid string without NUL bytes.");
    }
    const lexical = path.resolve(root, input || ".");
    if (!isInside(root, lexical)) throw new SecurityError(`Path escapes the workspace: ${input}`);

    let resolved;
    try {
      resolved = await realpath(lexical);
    } catch (error) {
      throw new SecurityError(`Path does not exist or cannot be resolved: ${input}`, { cause: error });
    }
    if (!isInside(root, resolved)) throw new SecurityError(`Resolved path escapes the workspace: ${input}`);

    const relative = toPosix(path.relative(root, resolved)) || ".";
    if (!allowSensitive && isSensitiveRelativePath(relative)) {
      throw new SecurityError(`Access to sensitive repository path is blocked: ${relative}`);
    }

    const item = await stat(resolved);
    if (kind === "file" && !item.isFile()) throw new SecurityError(`Expected a file: ${relative}`);
    if (kind === "directory" && !item.isDirectory()) throw new SecurityError(`Expected a directory: ${relative}`);
    if (kind === "any" && !item.isFile() && !item.isDirectory()) {
      throw new SecurityError(`Unsupported filesystem entry: ${relative}`);
    }
    return Object.freeze({ absolute: resolved, relative, stat: item });
  }

  function relative(absolutePath) {
    if (!isInside(root, absolutePath)) throw new SecurityError(`Path is outside the workspace: ${absolutePath}`);
    return toPosix(path.relative(root, absolutePath)) || ".";
  }

  return Object.freeze({ root, requestedRoot, resolveExisting, relative, isSensitiveRelativePath });
}

export const SENSITIVE_RG_GLOBS = Object.freeze([
  "!**/.git/**",
  "!**/.ssh/**",
  "!**/.gnupg/**",
  "!**/.aws/**",
  "!**/.azure/**",
  "!**/.kube/**",
  "!**/.env*",
  "!**/*.env",
  "!**/.dev.vars",
  "!**/.npmrc",
  "!**/.pypirc",
  "!**/.netrc",
  "!**/.git-credentials",
  "!**/id_rsa",
  "!**/id_dsa",
  "!**/id_ecdsa",
  "!**/id_ed25519",
  "!**/credentials",
  "!**/credentials.json",
  "!**/secrets.json",
  "!**/secrets.toml",
  "!**/secrets.yaml",
  "!**/secrets.yml",
  "!**/service-account.json",
  "!**/*.pem",
  "!**/*.p12",
  "!**/*.pfx",
  "!**/*.key",
  "!**/*.keystore",
]);
