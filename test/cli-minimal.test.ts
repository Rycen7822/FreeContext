import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeCli, type CliIo } from "../src/cli.js";

function sink(chunks: string[]): CliIo["stdout"] {
  return {
    write: ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as CliIo["stdout"]["write"],
  };
}

test("CLI text and JSON output remain ordinary text and write the benchmark session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-cli-minimal-"));
  const workspace = path.join(root, "workspace");
  const sessionFile = path.join(root, "sessions", "call.json");
  await mkdir(workspace);
  await mkdir(path.dirname(sessionFile), { mode: 0o700 });
  try {
    for (const format of ["text", "json"] as const) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const stdin = Readable.from([]) as CliIo["stdin"];
      Object.defineProperty(stdin, "isTTY", { value: true });
      const code = await executeCli([
        "--cwd", workspace,
        "--format", format,
        "--benchmark-session-file", sessionFile.replace("call.json", `${format}.json`),
        "Locate the implementation",
      ], {
        stdin,
        stdout: sink(stdout),
        stderr: sink(stderr),
      }, {
        runExplorer: async ({ invocation }) => ({
          status: "complete",
          text: "plain answer",
          errorCode: null,
          sessionId: invocation.sessionId,
          sessionFile: invocation.sessionFile,
        }),
      });
      assert.equal(code, 0, stderr.join(""));
      assert.equal(stderr.join(""), "");
      const output = format === "json" ? JSON.parse(stdout.join("")) as { text: string } : { text: stdout.join("") };
      assert.match(output.text, /^plain answer\n\nSession: [^\n]+\n?$/u);
      const document = JSON.parse(await readFile(sessionFile.replace("call.json", `${format}.json`), "utf8")) as {
        schemaVersion?: string;
        result?: { text?: string };
      };
      assert.equal(document.schemaVersion, "freecontext-mcp-session-v4");
      assert.equal(document.result?.text, "plain answer");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
