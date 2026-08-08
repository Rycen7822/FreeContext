import type { Stats } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Type } from "@earendil-works/pi-ai";
import type { FreeContextConfig } from "../config.js";
import type { Semaphore } from "./semaphore.js";

export type WorkspaceEntryKind = "any" | "file" | "directory";

export interface ResolvedWorkspaceEntry {
  readonly absolute: string;
  readonly relative: string;
  readonly stat: Stats;
}

export interface Workspace {
  readonly root: string;
  readonly requestedRoot: string;
  readonly resolveExisting: (
    input?: string,
    options?: Readonly<{ kind?: WorkspaceEntryKind; allowSensitive?: boolean }>,
  ) => Promise<ResolvedWorkspaceEntry>;
  readonly relative: (absolutePath: string) => string;
  readonly isSensitiveRelativePath: (relativePath: string) => boolean;
}

export interface ToolExecutables {
  readonly rg: string | null;
  readonly jq: string | null;
  readonly bat: string | null;
}

export interface ToolContext {
  readonly Type: typeof Type;
  readonly workspace: Workspace;
  readonly semaphore: Semaphore;
  readonly config: FreeContextConfig;
}

export interface ExternalToolContext extends ToolContext {
  readonly executable: string;
}

export interface RepositoryToolSet {
  readonly tools: readonly AgentTool[];
  readonly executables: Readonly<ToolExecutables>;
  readonly names: readonly string[];
}

export interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
}

export interface ProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
}
