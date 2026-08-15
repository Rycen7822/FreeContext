import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigurationError } from "../errors.js";
import type { ContextTokenCounter } from "../runtime/context-budget.js";
import { GigatokenCounter } from "../runtime/gigatoken-counter.js";
import { resolveWorkspaceRevision } from "../runtime/workspace-revision.js";
import { defaultSessionDirectory } from "../session/store.js";
import {
  FreeContextRequestSchema,
  FreeContextResultSchema,
  SERVER_INSTRUCTIONS,
  TOOL_DESCRIPTION,
} from "./contracts.js";
import { createGatherContextHandler } from "./tool.js";
import type { GatherContextHandlerDependencies, SingleFlightExecutor } from "./tool.js";

export interface McpServerArguments {
  readonly configFile?: string;
  readonly sessionDirectory: string;
}

export interface FreeContextMcpServerDependencies {
  readonly tokenCounter?: ContextTokenCounter;
  readonly closeTokenCounter?: () => Promise<void> | void;
  readonly runExplorer?: GatherContextHandlerDependencies["runExplorer"];
  readonly compileResult?: GatherContextHandlerDependencies["compileResult"];
  readonly reserveSession?: GatherContextHandlerDependencies["reserveSession"];
  readonly cancelSession?: GatherContextHandlerDependencies["cancelSession"];
  readonly commitSession?: GatherContextHandlerDependencies["commitSession"];
  readonly terminalStore?: GatherContextHandlerDependencies["terminalStore"];
  readonly deadlineClock?: GatherContextHandlerDependencies["deadlineClock"];
  readonly deadlineMs?: number;
  readonly invocationContextProvider?: GatherContextHandlerDependencies["invocationContextProvider"];
  readonly now?: () => Date;
}

export interface FreeContextMcpServerRuntime {
  readonly server: McpServer;
  readonly close: () => Promise<void>;
}

export function parseMcpServerArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Readonly<McpServerArguments> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--config" && flag !== "--session-dir") {
      throw new ConfigurationError(`Unknown MCP server argument: ${flag ?? "<missing>"}`);
    }
    if (values.has(flag)) throw new ConfigurationError(`Duplicate MCP server argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new ConfigurationError(`${flag} requires a value.`);
    values.set(flag, value);
    index += 1;
  }

  const configuredSessionDirectory = values.get("--session-dir") ?? env.FREECONTEXT_SESSION_DIR?.trim();
  const configFile = values.get("--config");
  return Object.freeze({
    ...(configFile ? { configFile: path.resolve(configFile) } : {}),
    sessionDirectory: configuredSessionDirectory
      ? path.resolve(configuredSessionDirectory)
      : defaultSessionDirectory(env),
  });
}

export function createSingleFlightExecutor(): SingleFlightExecutor {
  let tail: Promise<void> = Promise.resolve();
  return Object.freeze({
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(task, task);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  });
}

export function createFreeContextMcpServer(
  options: Readonly<McpServerArguments>,
  dependencies: Readonly<FreeContextMcpServerDependencies> = {},
): Readonly<FreeContextMcpServerRuntime> {
  const ownedCounter = dependencies.tokenCounter ? null : new GigatokenCounter();
  const tokenCounter = dependencies.tokenCounter ?? ownedCounter as GigatokenCounter;
  const processAbort = new AbortController();
  const executor = createSingleFlightExecutor();
  const server = new McpServer(
    { name: "freecontext", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const invocationContextProvider = dependencies.invocationContextProvider ?? (async (metadata: unknown) => {
    if (!metadata || typeof metadata !== "object" || !("requestId" in metadata)) {
      throw new ConfigurationError("The MCP host did not supply a request identity.");
    }
    const requestId = (metadata as Readonly<{ requestId?: unknown }>).requestId;
    if (typeof requestId !== "string" && typeof requestId !== "number") {
      throw new ConfigurationError("The MCP host supplied an invalid request identity.");
    }
    const roots = await server.server.listRoots();
    if (roots.roots.length !== 1) {
      throw new ConfigurationError("FreeContext requires exactly one MCP workspace root.");
    }
    const root = roots.roots[0];
    if (!root || !root.uri.startsWith("file://")) {
      throw new ConfigurationError("FreeContext requires one file:// MCP workspace root.");
    }
    const workspaceRoot = await realpath(fileURLToPath(root.uri));
    return Object.freeze({
      invocationId: randomUUID(),
      callId: String(requestId),
      workspaceRoot,
      workspaceRevision: await resolveWorkspaceRevision(workspaceRoot),
    });
  });
  const handler = createGatherContextHandler({
    tokenCounter,
    sessionDirectory: options.sessionDirectory,
    executor,
    invocationContextProvider,
    ...(options.configFile ? { configFile: options.configFile } : {}),
    ...(dependencies.runExplorer ? { runExplorer: dependencies.runExplorer } : {}),
    ...(dependencies.compileResult ? { compileResult: dependencies.compileResult } : {}),
    ...(dependencies.reserveSession ? { reserveSession: dependencies.reserveSession } : {}),
    ...(dependencies.cancelSession ? { cancelSession: dependencies.cancelSession } : {}),
    ...(dependencies.commitSession ? { commitSession: dependencies.commitSession } : {}),
    ...(dependencies.terminalStore ? { terminalStore: dependencies.terminalStore } : {}),
    ...(dependencies.deadlineClock ? { deadlineClock: dependencies.deadlineClock } : {}),
    ...(dependencies.deadlineMs !== undefined ? { deadlineMs: dependencies.deadlineMs } : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  server.registerTool(
    "gather_context",
    {
      title: "Gather context with FreeContext",
      description: TOOL_DESCRIPTION,
      inputSchema: FreeContextRequestSchema,
      outputSchema: FreeContextResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input, extra) => handler(input, extra, AbortSignal.any([extra.signal, processAbort.signal])),
  );

  let counterClose: Promise<void> | null = null;
  const closeCounter = (): Promise<void> => {
    counterClose ??= Promise.resolve(
      dependencies.closeTokenCounter?.() ?? ownedCounter?.close(),
    ).then(() => undefined);
    return counterClose;
  };
  server.server.onclose = () => {
    processAbort.abort(new Error("FreeContext MCP server closed."));
    void closeCounter();
  };

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      processAbort.abort(new Error("FreeContext MCP server shutting down."));
      try {
        await server.close();
      } finally {
        await closeCounter();
      }
    })();
    return closing;
  };
  return Object.freeze({ server, close });
}

export async function runMcpServer(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const runtime = createFreeContextMcpServer(parseMcpServerArgs(argv));
  if (process.env.FREECONTEXT_DEBUG === "1") {
    runtime.server.server.onerror = (error) => process.stderr.write(`[freecontext-mcp] ${error.message}\n`);
  }
  const shutdown = () => {
    void runtime.close().catch((error: unknown) => {
      process.stderr.write(`[freecontext-mcp] ${error instanceof Error ? error.message : String(error)}\n`);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await runtime.server.connect(new StdioServerTransport());
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
