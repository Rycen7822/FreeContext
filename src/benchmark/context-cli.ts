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
  const allowFlag = "--allow-unreferenced-sessions";
  const allowUnreferencedSessions = argv.includes(allowFlag);
  const agentDir = option(argv, "--agent-dir");
  const taskName = option(argv, "--task-name");
  if (
    !agentDir
    || !taskName
    || argv.length !== (allowUnreferencedSessions ? 5 : 4)
    || argv.filter((value) => value === allowFlag).length > 1
  ) {
    throw new Error(
      "usage: freecontext-benchmark-context --agent-dir PATH --task-name NAME "
      + "[--allow-unreferenced-sessions]",
    );
  }
  const outputPath = await exportMasterAgentContext({
    agentDir,
    taskName,
    allowUnreferencedSessions,
  });
  process.stdout.write(`${outputPath}\n`);
}
