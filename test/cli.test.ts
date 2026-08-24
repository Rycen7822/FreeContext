import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { executeCli } from "../src/cli.js";
import type { CliIo } from "../src/cli.js";
import { FreeContextResultSchema, serializeForModel } from "../src/mcp/contracts.js";
import { resolveWorkspaceRevision } from "../src/runtime/workspace-revision.js";

const CONFIG_KEY = "FREECONTEXT_CLI_TEST_KEY";
const execFileAsync = promisify(execFile);

function outputSink(chunks: string[]): CliIo["stdout"] {
  return {
    write: ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as CliIo["stdout"]["write"],
  };
}

test("CLI text output uses the canonical model serializer", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "freecontext-cli-"));
  const previousKey = process.env[CONFIG_KEY];
  try {
    const workspace = path.join(tempRoot, "workspace");
    const promptFile = path.join(tempRoot, "prompt.md");
    const configFile = path.join(tempRoot, "freecontext.toml");
    const sessionFile = path.join(tempRoot, "sessions", "call.json");
    await mkdir(workspace);
    await mkdir(path.dirname(sessionFile), { mode: 0o700 });
    await writeFile(promptFile, "{{WORKSPACE}} {{TOOLS}} {{OVERVIEW}}", "utf8");
    await writeFile(path.join(workspace, "document.md"), "first\nsecond\n", "utf8");
    await writeFile(configFile, `
version = 1
default_route = "default"

[runtime]
prompt_path = "prompt.md"

[providers.mock]
api = "openai"
base_url = "https://example.invalid/v1"
credential_env = "${CONFIG_KEY}"

[models.mock]
provider = "mock"
model_id = "mock-model"
context_window = 32768
max_output_tokens = 1024

[routes.default]
models = ["mock"]
`, "utf8");
    process.env[CONFIG_KEY] = "test-secret";

    const stdout: string[] = [];
    const stderr: string[] = [];
    const stdin = Readable.from([]) as CliIo["stdin"];
    Object.defineProperty(stdin, "isTTY", { value: true });
    const io: CliIo = {
      stdin,
      stdout: outputSink(stdout),
      stderr: outputSink(stderr),
    };
    let observedTaskText: string | undefined;
    let observedWorkspaceRevision: string | undefined;
    let expectedText: string | undefined;
    const code = await executeCli([
      "--config", configFile,
      "--cwd", workspace,
      "--benchmark-session-file", sessionFile,
      "Locate the implementation",
    ], io, {
      runExplorer: async (options) => {
        observedTaskText = options.request.taskText;
        observedWorkspaceRevision = options.invocation.workspaceRevision;
        const result = FreeContextResultSchema.parse({
          status: "ready",
          summary: "Validated summary.",
          evidence: [{
            id: "e1",
            role: "implementation",
            path: "document.md",
            startLine: 1,
            endLine: 2,
            focusLine: 1,
            questionId: "implementation",
            why: "Defines the behavior.",
          }],
          gaps: [],
          handoff: {
            id: `handoff:${options.invocation.invocationId}`,
            workUnit: options.request.workUnit,
            evidenceIds: ["e1"],
            outcome: { kind: options.request.workUnit.outcome, instruction: "Use the validated implementation evidence." },
            blockingGaps: [],
          },
          nextAction: {
            kind: "consume_evidence",
            reason: "Use the decisive implementation span.",
          },
          errorCode: null,
          sessionId: options.invocation.sessionId,
          sessionFile: options.invocation.sessionFile,
        });
        expectedText = serializeForModel(result);
        return result;
      },
    });

    assert.equal(code, 0, JSON.stringify({ stdout, stderr, observedTaskText }));
    assert.equal(observedTaskText, "Locate the implementation");
    assert.equal(observedWorkspaceRevision, "unversioned");
    assert.equal(stderr.join(""), "");
    assert.equal(stdout.join(""), `${expectedText}\n`);
  } finally {
    if (previousKey === undefined) delete process.env[CONFIG_KEY];
    else process.env[CONFIG_KEY] = previousKey;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("workspace revision resolver reports clean, dirty, and unversioned workspaces", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "freecontext-revision-"));
  try {
    const repository = path.join(tempRoot, "repository");
    const unversioned = path.join(tempRoot, "unversioned");
    await mkdir(repository);
    await mkdir(unversioned);
    await execFileAsync("git", ["init", "-q"], { cwd: repository });
    await writeFile(path.join(repository, "tracked.txt"), "clean\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: repository });
    await execFileAsync("git", ["-c", "user.name=FreeContext Test", "-c", "user.email=freecontext@example.invalid", "commit", "-qm", "initial"], { cwd: repository });
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository });
    const head = stdout.trim();

    assert.equal(await resolveWorkspaceRevision(repository), `git:${head}:clean`);
    await writeFile(path.join(repository, "tracked.txt"), "dirty\n", "utf8");
    assert.equal(await resolveWorkspaceRevision(repository), `git:${head}:dirty`);
    assert.equal(await resolveWorkspaceRevision(unversioned), "unversioned");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
