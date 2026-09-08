import { executeCli } from "../src/cli.js";

// Supply --intent and captured output through stdin or --output-file.
process.exitCode = await executeCli(process.argv.slice(2), process);
