import test from "node:test";
import assert from "node:assert/strict";
import { HELP_TEXT, parseArgs } from "../src/cli/args.js";

test("argument parser accepts command, aliases, equals form, and positional query", () => {
  const parsed = parseArgs(["explore", "-C", "/repo", "--format=json", "find", "the", "router"]);
  assert.equal(parsed.command, "explore");
  assert.equal(parsed.cwd, "/repo");
  assert.equal(parsed.format, "json");
  assert.equal(parsed.query, "find the router");
});

test("argument parser rejects ambiguity and unknown flags", () => {
  assert.throws(() => parseArgs(["--query", "x", "y"]), /either with --query/u);
  assert.throws(() => parseArgs(["--does-not-exist"]), /Unknown option/u);
  assert.throws(() => parseArgs(["--headers-json", '{"Authorization":"secret"}']), /Unknown option/u);
  assert.throws(() => parseArgs(["--format", "xml"]), /text or json/u);
});

test("argument parser accepts TOML routing and context controls", () => {
  const parsed = parseArgs([
    "--config",
    "/tmp/freecontext.toml",
    "--route=fast",
    "--no-context-compaction",
    "query",
  ]);
  assert.equal(parsed.configFile, "/tmp/freecontext.toml");
  assert.equal(parsed.route, "fast");
  assert.equal(parsed.contextCompactionEnabled, false);
  assert.equal(parsed.query, "query");

  const direct = parseArgs(["--target", "backup", "query"]);
  assert.equal(direct.target, "backup");
  assert.throws(() => parseArgs(["--context-reserve-tokens", "12000"]), /Unknown option/u);
});

test("argument parser scopes benchmark session capture to exploration", () => {
  const parsed = parseArgs(["explore", "--benchmark-session-file", "/logs/session.json", "query"]);
  assert.equal(parsed.benchmarkSessionFile, "/logs/session.json");
  assert.throws(
    () => parseArgs(["doctor", "--benchmark-session-file", "/logs/session.json"]),
    /only for explore/u,
  );
});

test("help describes the TOML credential boundary without legacy dotenv guidance", () => {
  assert.match(HELP_TEXT, /credential_env/u);
  assert.doesNotMatch(HELP_TEXT, /configured \.env/u);
});
