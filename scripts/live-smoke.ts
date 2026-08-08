import { runExplorer } from "../src/runtime/run.js";

const query = process.argv.slice(2).join(" ") ||
  "Locate the CLI entry point and the read-only tool registry. Return the narrow defining ranges.";
const result = await runExplorer({ query, cwd: process.cwd() });
process.stdout.write(`${result.answer}\n`);
