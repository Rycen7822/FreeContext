import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/cli/args.mjs";

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
