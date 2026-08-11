import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BenchmarkMasterAgentContext } from "../src/benchmark/master-context.js";
import { exportMasterAgentContext } from "../src/benchmark/master-context.js";

const RUNTIME_SESSION = "/logs/agent/freecontext-sessions/call-001.json";

function mcpSession() {
  const result = {
    status: "completed" as const,
    summary: "router found",
    evidence: [{ path: "src/router.ts", start: 1, end: 2, reason: "Defines the route." }],
    gaps: ["none"],
    sessionFile: RUNTIME_SESSION,
    error: null,
  };
  return {
    schemaVersion: "freecontext-mcp-session-v1" as const,
    transport: "mcp" as const,
    startedAt: "2026-08-09T00:00:00.000Z",
    finishedAt: "2026-08-09T00:01:00.000Z",
    invocation: { request: "locate the router", workspace: "/workspace" },
    capture: null,
    runtimeEvents: [],
    modelVisibleText: `Status: completed\nValidated spans: 1\nGaps: 1\nFull session: ${RUNTIME_SESSION}`,
    result,
    terminalError: null,
  };
}

function legacySession() {
  return {
    schemaVersion: "freecontext-benchmark-session-v1" as const,
    capturedAt: "2026-08-09T00:00:00.000Z",
    invocation: {
      request: "locate the router",
      cwd: "/workspace",
      cliOutput: "<final_answer>\nsummary: router found\nevidence:\n- src/router.ts:1-2 — route\ngaps:\n- none\n</final_answer>\n",
    },
    capture: {
      schemaVersion: "freecontext-session-v1",
      request: "locate the router",
      runtime: { workspace: "/workspace" },
      primary: { output: "raw model answer" },
      primaryValidation: { valid: true },
      repair: null,
      outcome: {
        status: "completed",
        answer: "<final_answer>\nsummary: router found\nevidence:\n- src/router.ts:1-2 — route\ngaps:\n- none\n</final_answer>",
      },
    },
    runtimeEvents: [],
    terminalError: null,
  };
}

async function createFixture(
  root: string,
  includeReference: boolean,
  session: ReturnType<typeof mcpSession> | ReturnType<typeof legacySession> = mcpSession(),
): Promise<Readonly<{
  agentDir: string;
  masterRaw: string;
  sessionRaw: string;
}>> {
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(agentDir, "sessions", "2026", "08", "09");
  const freeContextDir = path.join(agentDir, "freecontext-sessions");
  await Promise.all([
    mkdir(sessionDir, { recursive: true }),
    mkdir(freeContextDir, { recursive: true }),
  ]);
  const masterEvents: unknown[] = [{ type: "other_context", payload: "before" }];
  if (session.schemaVersion === "freecontext-mcp-session-v1") {
    const visibleResult = includeReference ? session.result : { ...session.result, sessionFile: null };
    const visibleText = includeReference
      ? session.modelVisibleText
      : "Status: completed\nValidated spans: 1\nGaps: 1\nFull session: unavailable";
    masterEvents.push(
      {
        type: "item.started",
        item: {
          id: "item_1",
          type: "mcp_tool_call",
          server: "freecontext",
          tool: "gather_context",
          arguments: { query: session.invocation.request, workspace: session.invocation.workspace },
          result: null,
          error: null,
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "item_1",
          type: "mcp_tool_call",
          server: "freecontext",
          tool: "gather_context",
          arguments: { query: session.invocation.request, workspace: session.invocation.workspace },
          result: {
            content: [{ type: "text", text: visibleText }],
            structured_content: visibleResult,
          },
          error: null,
          status: "completed",
        },
      },
    );
  } else {
    masterEvents.push({
      type: "freecontext_tool_output",
      payload: includeReference ? `compact output\n\nFreeContext full session: ${RUNTIME_SESSION}` : "compact output",
    });
  }
  masterEvents.push({ type: "other_context", payload: "after" });
  const masterRaw = `${masterEvents.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const sessionRaw = `${JSON.stringify(session, null, 2)}\n`;
  await Promise.all([
    writeFile(path.join(sessionDir, "rollout.jsonl"), masterRaw, "utf8"),
    writeFile(path.join(freeContextDir, "call-001.json"), sessionRaw, "utf8"),
  ]);
  return { agentDir, masterRaw, sessionRaw };
}

test("master context exporter preserves all master events and references separate FreeContext raw sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-master-"));
  try {
    const fixture = await createFixture(root, true);
    const outputPath = await exportMasterAgentContext({
      agentDir: fixture.agentDir,
      taskName: "TaskNameXXX",
      now: () => new Date("2026-08-09T01:00:00.000Z"),
    });
    const document = JSON.parse(await readFile(outputPath, "utf8")) as BenchmarkMasterAgentContext;

    assert.equal(document.taskName, "TaskNameXXX");
    assert.equal(document.masterAgentContext[0]?.rawJsonl, fixture.masterRaw);
    assert.equal(document.freeContextCalls.length, 1);
    assert.equal(document.freeContextCalls[0]?.promptToFreeContext, "locate the router");
    assert.equal(
      document.freeContextCalls[0]?.outputToMasterAgent,
      JSON.stringify({
        content: [{ type: "text", text: mcpSession().modelVisibleText }],
        structured_content: mcpSession().result,
      }, null, 2),
    );
    assert.equal(document.freeContextCalls[0]?.fullSessionFile, "freecontext-sessions/call-001.json");
    assert.equal(document.freeContextCalls[0]?.runtimeSessionFile, RUNTIME_SESSION);
    assert.equal(document.freeContextCalls[0]?.status, "completed");
    assert.equal(document.freeContextCalls[0]?.referenceFoundInMasterContext, true);
    assert.equal(
      await readFile(path.join(fixture.agentDir, "freecontext-sessions", "call-001.json"), "utf8"),
      fixture.sessionRaw,
    );
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("master context exporter retains legacy benchmark-v1 sessions during shadow adoption", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-master-"));
  try {
    const fixture = await createFixture(root, true, legacySession());
    const outputPath = await exportMasterAgentContext({ agentDir: fixture.agentDir, taskName: "legacy" });
    const document = JSON.parse(await readFile(outputPath, "utf8")) as BenchmarkMasterAgentContext;
    assert.equal(document.freeContextCalls[0]?.promptToFreeContext, "locate the router");
    assert.equal(document.freeContextCalls[0]?.status, "completed");
    assert.match(document.freeContextCalls[0]?.outputToMasterAgent ?? "", /<final_answer>/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("master context exporter fails when the master context omits a FreeContext session reference", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-master-"));
  try {
    const fixture = await createFixture(root, false);
    await assert.rejects(
      exportMasterAgentContext({ agentDir: fixture.agentDir, taskName: "TaskNameXXX" }),
      /does not reference/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("master context exporter rejects an MCP session path that differs from its exported file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "freecontext-master-"));
  try {
    const session = mcpSession();
    const mismatched = { ...session, result: { ...session.result, sessionFile: "/wrong/session.json" } };
    const fixture = await createFixture(root, true, mismatched);
    await assert.rejects(
      exportMasterAgentContext({ agentDir: fixture.agentDir, taskName: "TaskNameXXX" }),
      /path does not match exported file/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical Pier adapter registers atomic MCP without legacy guidance or CLI wrappers", async () => {
  const source = await readFile(
    new URL("../benchmarks/deepswe/pier_codex_freecontext_agent.py", import.meta.url),
    "utf8",
  );
  const freeContextConfig = await readFile(
    new URL("../benchmarks/deepswe/freecontext.toml", import.meta.url),
    "utf8",
  );
  assert.match(source, /\[mcp_servers\.freecontext\]/u);
  assert.match(source, /startup_timeout_sec = 30/u);
  assert.match(source, /tool_timeout_sec = 1800/u);
  assert.match(source, /enabled_tools = \["gather_context"\]/u);
  assert.match(source, /\[mcp_servers\.freecontext\.tools\.gather_context\]/u);
  assert.match(source, /approval_mode = "approve"/u);
  assert.match(source, /bin\/freecontext-mcp\.mjs/u);
  assert.match(source, /FREECONTEXT_PYTHON=\{_REMOTE_PYTHON\.as_posix\(\)\}/u);
  assert.match(source, /export TOKENRHYTHM_API_KEY FREECONTEXT_PYTHON NODE_USE_ENV_PROXY=1/u);
  assert.match(source, /--session-dir \{_REMOTE_SESSION_DIR\.as_posix\(\)\}/u);
  assert.match(source, /chmod 700 \{_REMOTE_SESSION_DIR\.as_posix\(\)\}/u);
  assert.match(source, /await super\(\)\.run\(instruction, environment, context\)/u);
  assert.match(source, /original_config_toml = self\._config_toml/u);
  assert.match(source, /self\._config_toml = original_config_toml/u);
  assert.match(source, /_REMOTE_SKILLS_DIR = _REMOTE_ROOT \/ "skills"/u);
  assert.match(source, /freecontext-benchmark-context\.mjs/u);
  assert.match(source, /benchmarks\/deepswe\/freecontext\.toml/u);
  assert.match(source, /FREECONTEXT_PROVIDER_BOOTSTRAP_PROFILE/u);
  assert.match(source, /model_providers", \{\}\)\.get\("tokenrhythm", \{\}\)/u);
  assert.match(source, /bootstrap_url\.rstrip\("\/"\) != configured_url\.rstrip\("\/"\)/u);
  assert.doesNotMatch(
    source,
    /FREECONTEXT_SUBAGENT_PROFILE|bootstrap\.get\("model_provider"\)|bootstrap\.get\("model"\)|wire_api/u,
  );
  assert.match(freeContextConfig, /^api = "openai"$/mu);
  assert.match(freeContextConfig, /^model_id = "deepseek-v4-flash-0731"$/mu);
  assert.match(freeContextConfig, /^credential_env = "TOKENRHYTHM_API_KEY"$/mu);
  for (const legacy of [
    "_GUIDANCE",
    "freecontext explore",
    "--benchmark-session-file",
    "_REMOTE_WRAPPER",
    "freecontext-pier",
    "/usr/local/bin/freecontext",
    "write_stdin",
  ]) {
    assert.equal(source.includes(legacy), false, `legacy adapter surface remains: ${legacy}`);
  }

  const skillSave = source.indexOf('original_skills_dir = getattr(self, "skills_dir", None)');
  const upload = source.indexOf("await self._upload_freecontext(environment)");
  const skillSet = source.indexOf("self.skills_dir = _REMOTE_SKILLS_DIR.as_posix()");
  const parentRun = source.indexOf("await super().run(instruction, environment, context)");
  const skillRestore = source.indexOf("self.skills_dir = original_skills_dir");
  const configRestore = source.indexOf("self._config_toml = original_config_toml");
  assert.ok(skillSave >= 0 && skillSave < upload);
  assert.ok(upload < skillSet && skillSet < parentRun);
  assert.ok(parentRun < skillRestore && skillRestore < configRestore);

  const configBlock = source.slice(
    source.indexOf("    def _freecontext_mcp_config_toml"),
    source.indexOf("    async def run", source.indexOf("    def _freecontext_mcp_config_toml")),
  );
  assert.match(
    configBlock,
    /^env_vars = \["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"\]$/mu,
  );
  assert.match(configBlock, /^required = true$/mu);
  assert.doesNotMatch(configBlock, /TOKENRHYTHM|credential|bearer/u);
  const cleanupBlock = source.slice(
    source.indexOf("    async def _cleanup_freecontext"),
    source.indexOf("class PierCodexControl"),
  );
  assert.doesNotMatch(cleanupBlock, /rm -rf|_REMOTE_ROOT/u);
  assert.match(source, /class PierCodexControl/u);
  assert.match(source, /await PierCodexBase\.run\(self, instruction, environment, context\)/u);
  const controlBlock = source.slice(source.indexOf("class PierCodexControl"));
  assert.doesNotMatch(controlBlock, /TOKENRHYTHM|_REMOTE_SECRET|mcp_servers|freecontext-sessions/u);
});
