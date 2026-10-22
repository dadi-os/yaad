/** Travel time between planner places and the least gap two blocks need, as pure functions. */

import type { Config } from "../config.js";

/** A place with coordinates. */
export type Located = { id: string; name: string; latitude: number; longitude: number };

/** Stored travel times keyed by `fromId>toId`, in minutes. */
export type TravelTable = Map<string, number>;

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in meters between two coordinates. */
export function haversineM(a: Located, b: Located): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * Minutes to get from `from` to `to`: a stored time for that direction, else the stored time
 * for the reverse direction, else the walked distance estimated from the coordinates (never
 * under `min_travel_min`). Zero between a place and itself.
 */
export function travelMinutes(from: Located, to: Located, stored: TravelTable, planner: Config["planner"]): number {
  if (from.id === to.id) {
    return 0;
  }
  const direct = stored.get(`${from.id}>${to.id}`) ?? stored.get(`${to.id}>${from.id}`);
  if (direct !== undefined) {
    return direct;
  }
  const walked = Math.ceil((haversineM(from, to) * planner.detour_factor) / planner.walk_m_per_min);
  return Math.max(walked, planner.min_travel_min);
}

/** What two consecutive blocks need between them, and why. */
export type RequiredGap = { minutes: number; travel: number | null };

/**
 * The least minutes between the end of one block and the start of the next: the travel plus
 * the buffer when both blocks have a place and the places differ, else the stretch minimum.
 */
export function requiredGap(
  from: Located | null,
  to: Located | null,
  stored: TravelTable,
  planner: Config["planner"],
): RequiredGap {
  if (from !== null && to !== null && from.id !== to.id) {
    const travel = travelMinutes(from, to, stored, planner);
    return { minutes: travel + planner.travel_buffer_min, travel };
  }
  return { minutes: planner.stretch_min, travel: null };
}
