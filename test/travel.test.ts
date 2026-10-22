import assert from "node:assert/strict";
import { test } from "node:test";
import { haversineM, requiredGap, travelMinutes, type Located, type TravelTable } from "../src/planner/travel.js";

const planner = { stretch_min: 10, travel_buffer_min: 5, walk_m_per_min: 80, detour_factor: 1.3, min_travel_min: 2 };

const wilson: Located = { id: "w", name: "Wilson Hall", latitude: 42.72279, longitude: -84.48889 };
const rec: Located = { id: "r", name: "Rec Center", latitude: 42.72428, longitude: -84.4934 };
const home: Located = { id: "h", name: "Home", latitude: 42.7268, longitude: -84.4571 };

test("distance between two campus buildings is a few hundred meters", () => {
  const d = haversineM(wilson, rec);
  assert.ok(d > 300 && d < 500, `got ${d}`);
});

test("travel is estimated from distance, never zero between places, and zero for the same place", () => {
  const walk = travelMinutes(wilson, rec, new Map(), planner);
  assert.ok(walk >= 5 && walk <= 9, `got ${walk}`);
  assert.equal(travelMinutes(wilson, wilson, new Map(), planner), 0);
  const near: Located = { ...wilson, id: "n", latitude: wilson.latitude + 0.00001 };
  assert.equal(travelMinutes(wilson, near, new Map(), planner), 2);
});

test("a stored time wins over the estimate, and one direction serves the other when only it is stored", () => {
  const stored: TravelTable = new Map([["h>w", 38]]);
  assert.equal(travelMinutes(home, wilson, stored, planner), 38);
  assert.equal(travelMinutes(wilson, home, stored, planner), 38);
  stored.set("w>h", 30);
  assert.equal(travelMinutes(wilson, home, stored, planner), 30);
});

test("two blocks at different places need travel plus buffer; same or unknown places need the stretch minimum", () => {
  const stored: TravelTable = new Map([["w>r", 14]]);
  assert.deepEqual(requiredGap(wilson, rec, stored, planner), { minutes: 19, travel: 14 });
  assert.deepEqual(requiredGap(wilson, wilson, stored, planner), { minutes: 10, travel: null });
  assert.deepEqual(requiredGap(wilson, null, stored, planner), { minutes: 10, travel: null });
  assert.deepEqual(requiredGap(null, null, stored, planner), { minutes: 10, travel: null });
});
