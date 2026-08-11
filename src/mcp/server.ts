import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { ConfigurationError } from "../errors.js";
import type { ContextTokenCounter } from "../runtime/context-budget.js";
import { GigatokenCounter } from "../runtime/gigatoken-counter.js";
import { defaultSessionDirectory } from "../session/store.js";
import {
  GatherContextInputSchema,
  GatherContextOutputSchema,
  INVOCATION_POLICY,
  SERVER_INSTRUCTIONS,
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
  readonly reserveSession?: GatherContextHandlerDependencies["reserveSession"];
  readonly commitSession?: GatherContextHandlerDependencies["commitSession"];
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
  const handler = createGatherContextHandler({
    tokenCounter,
    sessionDirectory: options.sessionDirectory,
    executor,
    ...(options.configFile ? { configFile: options.configFile } : {}),
    ...(dependencies.runExplorer ? { runExplorer: dependencies.runExplorer } : {}),
    ...(dependencies.reserveSession ? { reserveSession: dependencies.reserveSession } : {}),
    ...(dependencies.commitSession ? { commitSession: dependencies.commitSession } : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
  const server = new McpServer(
    { name: "freecontext", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  server.registerTool(
    "gather_context",
    {
      title: "Gather context with FreeContext",
      description: INVOCATION_POLICY,
      inputSchema: GatherContextInputSchema,
      outputSchema: GatherContextOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    (input, extra) => handler(input, AbortSignal.any([extra.signal, processAbort.signal])),
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
