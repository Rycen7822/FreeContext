import { executeCli } from "../src/cli.js";

const query = process.argv.slice(2).join(" ") ||
  "Locate the CLI entry point and the read-only tool registry. Return the narrow defining ranges.";
process.exitCode = await executeCli(["explore", query], process);
