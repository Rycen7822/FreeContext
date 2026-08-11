import test from "node:test";
import assert from "node:assert/strict";
import { GigatokenCounter } from "../src/runtime/gigatoken-counter.js";

test(
  "Gigatoken reuses one o200k_base worker for exact single and batch counts",
  { skip: process.env.FREECONTEXT_PYTHON ? false : "FREECONTEXT_PYTHON is not configured" },
  async () => {
    const counter = new GigatokenCounter();
    try {
      assert.equal(await counter.count("hello"), 1);
      assert.deepEqual(await counter.countBatch(["hello", "你好，GPT-5.6 Sol", ""]), [1, 8, 0]);
    } finally {
      await counter.close();
    }
  },
);
