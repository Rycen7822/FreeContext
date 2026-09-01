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
  benchmarkSessionFile?: string;
};

type ValueOptionKey = Exclude<
  keyof CliConfigOverrides,
  "apiKey" | "contextCompactionEnabled"
> | "query" | "cwd" | "format" | "benchmarkSessionFile";
type FlagOptionKey = "help" | "version" | "verbose" | "contextCompactionEnabled";

const VALUE_OPTIONS = new Map<string, ValueOptionKey>([
  ["-q", "query"],
  ["--query", "query"],
  ["-C", "cwd"],
  ["--cwd", "cwd"],
  ["--config", "configFile"],
  ["--route", "route"],
  ["--target", "target"],
  ["--prompt", "promptPath"],
  ["--format", "format"],
  ["--benchmark-session-file", "benchmarkSessionFile"],
  ["--max-turns", "maxTurns"],
  ["--max-tool-calls", "maxToolCalls"],
  ["--request-timeout-ms", "requestTimeoutMs"],
  ["--provider-retry-delays-ms", "providerRetryDelaysMs"],
  ["--tool-timeout-ms", "toolTimeoutMs"],
  ["--max-tool-output-bytes", "maxToolOutputBytes"],
  ["--max-parallel-tools", "maxParallelTools"],
]);

const FLAG_OPTIONS = new Map<string, Readonly<{ key: FlagOptionKey; value: boolean }>>([
  ["-h", { key: "help", value: true }],
  ["--help", { key: "help", value: true }],
  ["-V", { key: "version", value: true }],
  ["--version", { key: "version", value: true }],
  ["--verbose", { key: "verbose", value: true }],
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
  if (options.command === "doctor" && options.benchmarkSessionFile) {
    throw new ConfigurationError("--benchmark-session-file is available only for explore.");
  }
  return options;
}

export const HELP_TEXT = `FreeContext — read-only repository exploration subagent

Usage:
  freecontext [explore] [options] [query]
  freecontext doctor [options]

Core options:
  -q, --query TEXT             Exploration request; stdin is used when omitted
  -C, --cwd PATH               Repository root (default: current directory)
      --config PATH            Load configuration from this TOML file
      --route NAME             Select a named model route
      --target NAME            Select one model target and disable fallback
      --prompt PATH            Load the system prompt from this Markdown file
      --format text|json        Output format (default: text)
      --max-turns N             Safety ceiling for model turns (2-8; default 8)
      --max-tool-calls N        Repository tool calls (1-18; default 18)
      --request-timeout-ms N    Provider request timeout in milliseconds
      --provider-retry-delays-ms LIST
                                Comma-separated retry waits; empty disables retries
      --no-context-compaction   Disable proactive compaction
      --benchmark-session-file PATH
                                Save the full benchmark-only session outside the explored workspace
      --verbose                 Emit lifecycle diagnostics to stderr
  -h, --help                    Show help
  -V, --version                 Show version

API keys are intentionally unavailable as CLI or TOML values. Provide the environment variables named by provider credential_env fields.`;
