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

test("loadConfig requires TZ to be an IANA zone", () => {
  const previous = process.env.TZ;
  try {
    for (const [value, error] of [
      [undefined, /TZ is required/],
      ["Mars/Olympus", /TZ is not an IANA time zone: Mars\/Olympus/],
    ] as const) {
      resetConfigCache();
      if (value === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = value;
      }
      assert.throws(() => loadConfig(), error);
    }
  } finally {
    if (previous === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
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
