import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GigatokenCounter } from "../runtime/gigatoken-counter.js";
import { analyzeBenchmarkCosts, type BenchmarkCostInput } from "./cost-analysis.js";

export async function runBenchmarkCostCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const [inputArgument, outputArgument] = argv;
  if (!inputArgument || !outputArgument) throw new Error("Usage: freecontext-benchmark-costs INPUT.json OUTPUT.json");
  const inputPath = path.resolve(inputArgument);
  const outputPath = path.resolve(outputArgument);
  const input = JSON.parse(await readFile(inputPath, "utf8")) as BenchmarkCostInput;
  const tokenizer = new GigatokenCounter();
  try {
    const report = await analyzeBenchmarkCosts(input, tokenizer);
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } finally {
    await tokenizer.close();
  }
}
