#!/usr/bin/env node
import { runBenchmarkContextCli } from "../dist/benchmark/context-cli.js";

await runBenchmarkContextCli().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
