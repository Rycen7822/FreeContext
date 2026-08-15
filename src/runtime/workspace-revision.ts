import { findExecutable, runCommand } from "../tools/process.js";

const UNVERSIONED = "unversioned";

export async function resolveWorkspaceRevision(workspaceRoot: string): Promise<string> {
  try {
    const git = await findExecutable("git");
    if (!git) return UNVERSIONED;
    const [head, status] = await Promise.all([
      runCommand({ command: git, args: ["rev-parse", "--verify", "HEAD"], cwd: workspaceRoot, maxOutputBytes: 64 * 1024 }),
      runCommand({ command: git, args: ["status", "--porcelain=v1", "--untracked-files=no"], cwd: workspaceRoot, maxOutputBytes: 1024 * 1024 }),
    ]);
    if (head.code !== 0 || head.truncated || status.code !== 0 || status.truncated) return UNVERSIONED;
    return `git:${head.stdout.trim()}:${status.stdout.trim() ? "dirty" : "clean"}`;
  } catch {
    return UNVERSIONED;
  }
}
