#!/usr/bin/env node
import { runBenchmarkCostCli } from "../dist/benchmark/cost-cli.js";

await runBenchmarkCostCli().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
