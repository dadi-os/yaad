import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, resetConfigCache } from "../src/config.js";

test("loadConfig requires DATABASE_URL", () => {
  resetConfigCache();
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    assert.throws(() => loadConfig(), /DATABASE_URL is required/);
  } finally {
    if (previous !== undefined) {
      process.env.DATABASE_URL = previous;
    }
    resetConfigCache();
  }
});

test("loadConfig returns databaseUrl when set", () => {
  resetConfigCache();
  assert.ok(process.env.DATABASE_URL);
  const config = loadConfig();
  assert.equal(config.env.databaseUrl, process.env.DATABASE_URL);
});
