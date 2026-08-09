import { exportMasterAgentContext } from "./master-context.js";

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export async function runBenchmarkContextCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const agentDir = option(argv, "--agent-dir");
  const taskName = option(argv, "--task-name");
  if (!agentDir || !taskName || argv.length !== 4) {
    throw new Error("usage: freecontext-benchmark-context --agent-dir PATH --task-name NAME");
  }
  const outputPath = await exportMasterAgentContext({ agentDir, taskName });
  process.stdout.write(`${outputPath}\n`);
}
