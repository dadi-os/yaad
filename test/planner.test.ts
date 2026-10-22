import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildApp } from "../src/app.js";
import { mockDwar, openTestDb, testConfig } from "./helpers.js";

const config = testConfig();
const handle = await openTestDb();

before(async () => {
  await handle.sql`TRUNCATE planner_block, planner_place CASCADE`;
});

after(async () => {
  await handle.close();
});

async function call(method: "POST" | "PATCH" | "DELETE" | "PUT" | "GET", url: string, payload?: Record<string, unknown>) {
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({ dimension: config.embedding.dimension }),
  });
  const res = await app.inject({ method, url, ...(payload ? { payload } : {}) });
  await app.close();
  return res;
}

const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 9, 21, hour, minute)).toISOString();

function block(title: string, start: [number, number?], end: [number, number?], extra: Record<string, unknown> = {}) {
  return { title, start_at: at(...start), end_at: at(...end), kind: "study", icon: "pencil", ...extra };
}

const day = { from: at(0), to: at(24) };

test("replace writes a source's day, reads it back in order, and a second replace swaps it", async () => {
  await handle.sql`TRUNCATE planner_block`;
  const first = await call("POST", "/planner/replace", {
    source: "schedule-specialist",
    ...day,
    blocks: [block("Gym", [15], [16], { kind: "gym", icon: "pulse" }), block("Wake up", [7], [7, 30], { kind: "wake", icon: "sun" })],
  });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json().blocks.map((b: { title: string }) => b.title), ["Wake up", "Gym"]);
  assert.equal(first.json().blocks[0].fixed, true);
  assert.equal(first.json().blocks[0].done_at, null);

  const second = await call("POST", "/planner/replace", {
    source: "schedule-specialist",
    ...day,
    blocks: [block("Study", [9], [10])],
  });
  assert.deepEqual(second.json().blocks.map((b: { title: string }) => b.title), ["Study"]);

  const read = await call("POST", "/planner/query", { from: at(9, 30), to: at(9, 45) });
  assert.deepEqual(read.json().blocks.map((b: { title: string }) => b.title), ["Study"]);
});

test("replace leaves other sources' blocks and blocks outside its range alone", async () => {
  await handle.sql`TRUNCATE planner_block`;
  await call("POST", "/planner/blocks", { source: "manual", ...block("Dentist", [11], [12], { kind: "fixed", icon: "flag" }) });
  await call("POST", "/planner/replace", { source: "other-agent", from: at(0), to: at(24), blocks: [block("Late", [20], [21])] });
  const res = await call("POST", "/planner/replace", {
    source: "schedule-specialist",
    from: at(0),
    to: at(12),
    blocks: [block("Early", [8], [9])],
  });
  assert.deepEqual(res.json().blocks.map((b: { title: string }) => b.title), ["Early", "Dentist"]);
  const all = await call("POST", "/planner/query", day);
  assert.deepEqual(all.json().blocks.map((b: { title: string }) => b.title), ["Early", "Dentist", "Late"]);
});

test("an overlapping write is a 409 overlap that names the pair and changes nothing", async () => {
  await handle.sql`TRUNCATE planner_block`;
  await call("POST", "/planner/replace", { source: "schedule-specialist", ...day, blocks: [block("Class", [9], [10], { kind: "class", icon: "book" })] });
  const res = await call("POST", "/planner/replace", {
    source: "other-agent",
    ...day,
    blocks: [block("Call", [9, 30], [10, 30])],
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.type, "overlap");
  assert.match(res.json().error.message, /"Call".*"Class"/);
  const read = await call("POST", "/planner/query", day);
  assert.deepEqual(read.json().blocks.map((b: { title: string }) => b.title), ["Class"]);

  const allowed = await call("POST", "/planner/replace", {
    source: "other-agent",
    ...day,
    blocks: [block("Call", [9, 30], [10, 30], { overlap_ok: true })],
  });
  assert.equal(allowed.statusCode, 200);
});

test("replace rejects a block that starts outside the range and two overlapping new blocks", async () => {
  await handle.sql`TRUNCATE planner_block`;
  const outside = await call("POST", "/planner/replace", { source: "manual", from: at(0), to: at(12), blocks: [block("Late", [13], [14])] });
  assert.equal(outside.statusCode, 422);
  assert.equal(outside.json().error.type, "out_of_range");
  const clash = await call("POST", "/planner/replace", {
    source: "manual",
    ...day,
    blocks: [block("A", [9], [10]), block("B", [9, 30], [10, 30])],
  });
  assert.equal(clash.statusCode, 409);
});

test("a block must end after it starts and use a known kind and icon", async () => {
  const backwards = await call("POST", "/planner/blocks", { source: "manual", ...block("Bad", [10], [9]) });
  assert.equal(backwards.statusCode, 422);
  const unknown = await call("POST", "/planner/blocks", { source: "manual", ...block("Bad", [9], [10], { icon: "dumbbell" }) });
  assert.equal(unknown.statusCode, 422);
  assert.equal(unknown.json().error.type, "invalid_request");
});

test("patch marks a block done and back, moves it, and refuses a move onto another block", async () => {
  await handle.sql`TRUNCATE planner_block`;
  const created = await call("POST", "/planner/blocks", { source: "manual", ...block("Study", [9], [10]) });
  assert.equal(created.statusCode, 201);
  const id = created.json().id;
  await call("POST", "/planner/blocks", { source: "manual", ...block("Lunch", [12], [13], { kind: "meal", icon: "fork" }) });

  const done = await call("PATCH", `/planner/blocks/${id}`, { done: true });
  assert.equal(done.statusCode, 200);
  assert.notEqual(done.json().done_at, null);
  const open = await call("PATCH", `/planner/blocks/${id}`, { done: false });
  assert.equal(open.json().done_at, null);

  const moved = await call("PATCH", `/planner/blocks/${id}`, { start_at: at(10), end_at: at(11) });
  assert.equal(moved.json().start_at, at(10));
  const clash = await call("PATCH", `/planner/blocks/${id}`, { start_at: at(12, 30), end_at: at(13, 30) });
  assert.equal(clash.statusCode, 409);
});

test("an unknown block id is a 404 on patch and delete, and delete removes the block", async () => {
  await handle.sql`TRUNCATE planner_block`;
  const missing = "00000000-0000-4000-8000-000000000000";
  assert.equal((await call("PATCH", `/planner/blocks/${missing}`, { title: "x" })).statusCode, 404);
  assert.equal((await call("DELETE", `/planner/blocks/${missing}`)).statusCode, 404);
  const created = await call("POST", "/planner/blocks", { source: "manual", ...block("Study", [9], [10]) });
  assert.equal((await call("DELETE", `/planner/blocks/${created.json().id}`)).statusCode, 200);
  const read = await call("POST", "/planner/query", day);
  assert.deepEqual(read.json().blocks, []);
});

async function seedPlaces() {
  await handle.sql`TRUNCATE planner_block, planner_place CASCADE`;
  await call("PUT", "/planner/places", { name: "Wilson Hall", latitude: 42.72279, longitude: -84.48889 });
  await call("PUT", "/planner/places", { name: "Rec Center", aliases: ["gym"], latitude: 42.72428, longitude: -84.4934 });
  await call("PUT", "/planner/places", { name: "Home", aliases: ["apartment"], latitude: 42.7268, longitude: -84.4571 });
}

test("a block names its place by name or alias, and an unknown place is a 422 listing the known ones", async () => {
  await seedPlaces();
  const ok = await call("POST", "/planner/blocks", { source: "manual", ...block("Gym", [15], [16], { kind: "gym", icon: "pulse", place: "GYM" }) });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().place, "Rec Center");
  const unknown = await call("POST", "/planner/blocks", { source: "manual", ...block("Lunch", [12], [13], { place: "Moon" }) });
  assert.equal(unknown.statusCode, 422);
  assert.equal(unknown.json().error.type, "unknown_place");
  assert.match(unknown.json().error.message, /Home, Rec Center, Wilson Hall/);
});

test("blocks at different places need the trip plus the buffer, and the error says the earliest start", async () => {
  await seedPlaces();
  await call("PUT", "/planner/travel", { from: "Wilson Hall", to: "Rec Center", minutes: 14 });
  await call("POST", "/planner/blocks", { source: "manual", ...block("Class", [13], [14, 20], { kind: "class", icon: "book", place: "Wilson Hall" }) });
  const tight = await call("POST", "/planner/blocks", { source: "manual", ...block("Gym", [14, 30], [15, 30], { kind: "gym", icon: "pulse", place: "Rec Center" }) });
  assert.equal(tight.statusCode, 409);
  assert.equal(tight.json().error.type, "spacing");
  assert.match(tight.json().error.message, /14 min plus a 5 min buffer/);
  assert.match(tight.json().error.message, /Wed \d\d:\d\d at the earliest/);
  const fine = await call("POST", "/planner/blocks", { source: "manual", ...block("Gym", [14, 40], [15, 30], { kind: "gym", icon: "pulse", place: "Rec Center" }) });
  assert.equal(fine.statusCode, 201);
  assert.equal(fine.json().travel_min, null);
  const read = await call("POST", "/planner/query", day);
  assert.deepEqual(read.json().blocks.map((b: { travel_min: number | null }) => b.travel_min), [null, 14]);
});

test("blocks at the same place or with no place need the stretch minimum, and overlap_ok lifts it", async () => {
  await seedPlaces();
  await call("POST", "/planner/blocks", { source: "manual", ...block("A", [9], [10]) });
  const tight = await call("POST", "/planner/blocks", { source: "manual", ...block("B", [10, 5], [11]) });
  assert.equal(tight.statusCode, 409);
  assert.equal(tight.json().error.type, "spacing");
  assert.match(tight.json().error.message, /at least 10 min between tasks/);
  const ok = await call("POST", "/planner/blocks", { source: "manual", ...block("B", [10, 10], [11]) });
  assert.equal(ok.statusCode, 201);
  const lifted = await call("POST", "/planner/blocks", { source: "manual", ...block("C", [11, 2], [12], { overlap_ok: true }) });
  assert.equal(lifted.statusCode, 201);
});

test("replace checks spacing against the blocks beside the range and a stored time overrides the estimate", async () => {
  await seedPlaces();
  await call("POST", "/planner/blocks", { source: "manual", ...block("Evening", [20], [21], { place: "Home" }) });
  await call("PUT", "/planner/travel", { from: "Wilson Hall", to: "Home", minutes: 38 });
  const tight = await call("POST", "/planner/replace", {
    source: "schedule-specialist",
    from: at(0),
    to: at(19, 30),
    blocks: [block("Late class", [18, 30], [19, 30], { kind: "class", icon: "book", place: "Wilson Hall" })],
  });
  assert.equal(tight.statusCode, 409);
  assert.match(tight.json().error.message, /38 min plus a 5 min buffer/);
  const places = await call("GET", "/planner/places");
  assert.deepEqual(places.json().travel, [{ from: "Wilson Hall", to: "Home", minutes: 38 }]);
});
