import { ConfigurationError } from "../errors.mjs";

const VALUE_OPTIONS = new Map([
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
  ["--temperature", "temperature"],
  ["--thinking-level", "thinkingLevel"],
]);

const FLAG_OPTIONS = new Map([
  ["-h", "help"],
  ["--help", "help"],
  ["-V", "version"],
  ["--version", "version"],
  ["--verbose", "verbose"],
  ["--no-repair", "noRepair"],
]);

export function parseArgs(argv) {
  const options = { command: "explore", format: "text", positional: [] };
  let index = 0;
  if (argv[0] && !argv[0].startsWith("-") && ["explore", "doctor"].includes(argv[0])) {
    options.command = argv[0];
    index = 1;
  }

  while (index < argv.length) {
    const token = argv[index];
    if (token === "--") {
      options.positional.push(...argv.slice(index + 1));
      break;
    }

    const equalIndex = token.startsWith("--") ? token.indexOf("=") : -1;
    const name = equalIndex > 0 ? token.slice(0, equalIndex) : token;
    const inlineValue = equalIndex > 0 ? token.slice(equalIndex + 1) : undefined;

    if (FLAG_OPTIONS.has(name)) {
      if (inlineValue !== undefined) throw new ConfigurationError(`${name} does not accept a value.`);
      options[FLAG_OPTIONS.get(name)] = true;
      index += 1;
      continue;
    }

    if (VALUE_OPTIONS.has(name)) {
      const value = inlineValue !== undefined ? inlineValue : argv[index + 1];
      if (value === undefined || (inlineValue === undefined && value.startsWith("-") && !/^-[0-9]/u.test(value))) {
        throw new ConfigurationError(`${name} requires a value.`);
      }
      options[VALUE_OPTIONS.get(name)] = value;
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
  if (!new Set(["text", "json"]).has(options.format)) {
    throw new ConfigurationError(`--format must be text or json, received: ${options.format}`);
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
      --env PATH               Load configuration from this .env file
      --prompt PATH            Load the system prompt from this Markdown file
      --api anthropic|openai    Compatible API protocol
      --auth-mode MODE         auto, bearer, x-api-key, or both
      --base-url URL            Provider base URL
      --model ID                Provider model identifier
      --format text|json        Output format (default: text)
      --max-turns N             Maximum model turns
      --max-tool-calls N        Maximum repository tool calls
      --thinking-level LEVEL    off, minimal, low, medium, high, xhigh, or max
      --no-repair               Disable one-pass output-contract repair
      --verbose                 Emit lifecycle diagnostics to stderr
  -h, --help                    Show help
  -V, --version                 Show version

The API key is intentionally unavailable as a CLI argument. Store it in the configured .env file or process environment.`;
