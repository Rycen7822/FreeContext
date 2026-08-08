import { ConfigurationError } from "../errors.js";
import type { CliConfigOverrides } from "../config.js";

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

export type CliOptions = Mutable<CliConfigOverrides> & {
  command: "explore" | "doctor";
  format: "text" | "json";
  positional: string[];
  query?: string;
  cwd?: string;
  help?: boolean;
  version?: boolean;
  verbose?: boolean;
  noRepair?: boolean;
};

type ValueOptionKey = Exclude<
  keyof CliConfigOverrides,
  "apiKey" | "contextCompactionEnabled"
> | "query" | "cwd" | "format";
type FlagOptionKey = "help" | "version" | "verbose" | "noRepair" | "contextCompactionEnabled";

const VALUE_OPTIONS = new Map<string, ValueOptionKey>([
  ["-q", "query"],
  ["--query", "query"],
  ["-C", "cwd"],
  ["--cwd", "cwd"],
  ["--env", "envFile"],
  ["--prompt", "promptPath"],
  ["--api", "api"],
  ["--auth-mode", "authMode"],
  ["--base-url", "baseUrl"],
  ["--model", "model"],
  ["--format", "format"],
  ["--max-turns", "maxTurns"],
  ["--max-tool-calls", "maxToolCalls"],
  ["--max-output-tokens", "maxOutputTokens"],
  ["--request-timeout-ms", "requestTimeoutMs"],
  ["--tool-timeout-ms", "toolTimeoutMs"],
  ["--max-tool-output-bytes", "maxToolOutputBytes"],
  ["--max-parallel-tools", "maxParallelTools"],
  ["--context-window", "contextWindow"],
  ["--context-reserve-tokens", "contextReserveTokens"],
  ["--context-keep-recent-tokens", "contextKeepRecentTokens"],
  ["--temperature", "temperature"],
  ["--thinking-level", "thinkingLevel"],
]);

const FLAG_OPTIONS = new Map<string, Readonly<{ key: FlagOptionKey; value: boolean }>>([
  ["-h", { key: "help", value: true }],
  ["--help", { key: "help", value: true }],
  ["-V", { key: "version", value: true }],
  ["--version", { key: "version", value: true }],
  ["--verbose", { key: "verbose", value: true }],
  ["--no-repair", { key: "noRepair", value: true }],
  ["--no-context-compaction", { key: "contextCompactionEnabled", value: false }],
]);

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { command: "explore", format: "text", positional: [] };
  let index = 0;
  const first = argv[0];
  if (first === "explore" || first === "doctor") {
    options.command = first;
    index = 1;
  }

  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) break;
    if (token === "--") {
      options.positional.push(...argv.slice(index + 1));
      break;
    }

    const equalIndex = token.startsWith("--") ? token.indexOf("=") : -1;
    const name = equalIndex > 0 ? token.slice(0, equalIndex) : token;
    const inlineValue = equalIndex > 0 ? token.slice(equalIndex + 1) : undefined;

    const flag = FLAG_OPTIONS.get(name);
    if (flag) {
      if (inlineValue !== undefined) throw new ConfigurationError(`${name} does not accept a value.`);
      options[flag.key] = flag.value;
      index += 1;
      continue;
    }

    const optionKey = VALUE_OPTIONS.get(name);
    if (optionKey) {
      const value = inlineValue !== undefined ? inlineValue : argv[index + 1];
      if (value === undefined || (inlineValue === undefined && value.startsWith("-") && !/^-[0-9]/u.test(value))) {
        throw new ConfigurationError(`${name} requires a value.`);
      }
      if (optionKey === "format") {
        if (value !== "text" && value !== "json") {
          throw new ConfigurationError(`--format must be text or json, received: ${value}`);
        }
        options.format = value;
      } else {
        options[optionKey] = value;
      }
      index += inlineValue !== undefined ? 1 : 2;
      continue;
    }

    if (token.startsWith("-")) throw new ConfigurationError(`Unknown option: ${token}`);
    options.positional.push(token);
    index += 1;
  }

  if (options.query && options.positional.length) {
    throw new ConfigurationError("Provide the query either with --query or as positional text, not both.");
  }
  if (!options.query && options.positional.length) options.query = options.positional.join(" ");
  return options;
}

export const HELP_TEXT = `FreeContext — read-only repository exploration subagent

Usage:
  freecontext [explore] [options] [query]
  freecontext doctor [options]

Core options:
  -q, --query TEXT             Exploration request; stdin is used when omitted
  -C, --cwd PATH               Repository root (default: current directory)
      --env PATH               Load configuration from this .env file
      --prompt PATH            Load the system prompt from this Markdown file
      --api anthropic|openai    Compatible API protocol
      --auth-mode MODE         auto, bearer, x-api-key, or both
      --base-url URL            Provider base URL
      --model ID                Provider model identifier
      --format text|json        Output format (default: text)
      --max-turns N             Maximum model turns
      --max-tool-calls N        Maximum repository tool calls
      --context-reserve-tokens N
                                Tokens reserved for output and compaction
      --context-keep-recent-tokens N
                                Approximate recent transcript tokens to retain
      --no-context-compaction   Disable proactive compaction and overflow recovery
      --thinking-level LEVEL    off, minimal, low, medium, high, xhigh, or max
      --no-repair               Disable one-pass output-contract repair
      --verbose                 Emit lifecycle diagnostics to stderr
  -h, --help                    Show help
  -V, --version                 Show version

The API key is intentionally unavailable as a CLI argument. Store it in the configured .env file or process environment.`;
