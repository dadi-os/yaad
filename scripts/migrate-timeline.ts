/**
 * One-off: turns the legacy recurring plans into plain stored rows, between migration 0006 and the
 * migration that drops the legacy columns. Run it on the box after 0006 and before that drop:
 * `TZ=<box zone> DATABASE_URL=... npx tsx scripts/migrate-timeline.ts --through YYYY-MM-DD [--apply]`.
 * Without `--apply` everything runs in a transaction that is rolled back, and the counts are printed.
 *
 * A recurring plan with a start becomes a hub (a memory) and one plan per occurrence from its start
 * through `--through`, each linked `HAS_SESSION`, with the hub's place, the matching `plan_occurrence`
 * row (moved, outcome, actual times; a cancelled session is left out) and the matching `HAS_NOTE` notes. A recurring plan
 * anchored on a due (rent on the 1st) becomes one task per occurrence. Plans that have both a start and
 * a due, and routine-kind plans, are listed for a decision and left alone.
 */

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import rrule from "rrule";
import { loadConfig } from "../src/config.js";
import { localDate, localInstant, localTime } from "../src/local-time.js";

const { rrulestr } = rrule;

type Legacy = {
  id: string;
  title: string;
  body: string | null;
  source: string;
  agent_id: string | null;
  occurred_at: Date | null;
  end_at: Date | null;
  recurrence: string;
  due_at: Date | null;
  opens_at: Date | null;
  time_zone: string | null;
  hide_from_planner: boolean;
};

type Occurrence = { plan_id: string; occurrence_date: string; state: string; start_at: Date | null; end_at: Date | null; outcome: string | null; outcome_at: Date | null; actual_start: Date | null; actual_end: Date | null };

/** Thrown to roll the transaction back after a dry run. */
class DryRun extends Error {}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const through = args[args.indexOf("--through") + 1];
if (args.indexOf("--through") === -1 || !through || !/^\d{4}-\d{2}-\d{2}$/.test(through)) {
  throw new Error("--through YYYY-MM-DD is required: the last day to create sessions for");
}

const config = loadConfig();
/**
 * A plain client, not `createDb`: Drizzle swaps the client's timestamp and date parsers for
 * pass-through strings, and this script reads instants as Dates and sends Dates as parameters.
 */
const client = postgres(config.env.databaseUrl, { onnotice: () => {} });
const zone = config.env.timezone;

/** The instants of `rule`'s occurrences from `anchor` through the local date `last`, in `zoneName`'s wall clock. */
function expand(rule: string, anchor: Date, last: string, zoneName: string): Date[] {
  const wall = `${localDate(anchor, zoneName).replace(/-/g, "")}T${localTime(anchor, zoneName).replace(":", "")}00`;
  const lines = rule.includes(":") ? rule : `RRULE:${rule}`;
  const set = rrulestr(`DTSTART:${wall}\n${lines}`, { forceset: true });
  const until = new Date(`${last}T23:59:59Z`);
  return set.between(new Date(`${localDate(anchor, zoneName)}T00:00:00Z`), until, true).map((floating) => {
    const iso = floating.toISOString();
    return localInstant(iso.slice(0, 10), iso.slice(11, 16), zoneName);
  });
}

try {
  const counts = { hubs: 0, sessions: 0, tasks: 0, notes: 0, skippedMoves: 0 };
  await client.begin(async (tx) => {
    const series = await tx<Legacy[]>`
      SELECT n.id, n.title, n.body, n.source, n.agent_id, n.occurred_at, d.end_at, d.recurrence, d.due_at, d.opens_at, d.time_zone, d.hide_from_planner
      FROM node n JOIN plan_detail d ON d.node_id = n.id
      WHERE n.kind = 'plan' AND d.recurrence IS NOT NULL`;
    for (const plan of series) {
      const where = plan.time_zone ?? zone;
      const overrides = await tx<Occurrence[]>`
        SELECT plan_id, occurrence_date::text AS occurrence_date, state, start_at, end_at, outcome, outcome_at, actual_start, actual_end
        FROM plan_occurrence WHERE plan_id = ${plan.id}`;
      const places = await tx<{ dst_id: string; properties: Record<string, unknown> }[]>`
        SELECT dst_id, properties FROM edge WHERE src_id = ${plan.id} AND type = 'AT_LOCATION' AND valid_to IS NULL`;
      const notes = await tx<{ id: string; dst_id: string; properties: { occurrence?: string } }[]>`
        SELECT id, dst_id, properties FROM edge WHERE src_id = ${plan.id} AND type = 'HAS_NOTE' AND valid_to IS NULL`;

      if (plan.occurred_at === null) {
        const due = plan.due_at;
        if (due === null) {
          throw new Error(`recurring plan ${plan.id} "${plan.title}" has neither a start nor a due`);
        }
        const shift = plan.opens_at === null ? null : due.getTime() - plan.opens_at.getTime();
        for (const at of expand(plan.recurrence, due, through, where)) {
          const id = randomUUID();
          const day = localDate(at, where);
          const done = overrides.find((row) => row.occurrence_date === day && row.outcome === "done");
          await tx`INSERT INTO node (id, kind, title, body, source, agent_id) VALUES (${id}, 'task', ${plan.title}, ${plan.body}, ${plan.source}, ${plan.agent_id})`;
          await tx`INSERT INTO task_detail (node_id, opens_on, closes_at, done_at) VALUES (${id}, ${shift === null ? day : localDate(new Date(at.getTime() - shift), where)}, ${at}, ${done?.outcome_at ?? null})`;
          counts.tasks += 1;
        }
        await tx`DELETE FROM node WHERE id = ${plan.id}`;
        continue;
      }

      const length = plan.end_at === null ? null : plan.end_at.getTime() - plan.occurred_at.getTime();
      await tx`DELETE FROM plan_detail WHERE node_id = ${plan.id}`;
      await tx`UPDATE node SET kind = 'memory', occurred_at = NULL WHERE id = ${plan.id}`;
      counts.hubs += 1;
      const planned = new Set<string>();
      for (const at of expand(plan.recurrence, plan.occurred_at, through, where)) {
        const day = localDate(at, where);
        planned.add(day);
        const row = overrides.find((override) => override.occurrence_date === day);
        if (row?.state === "cancelled") {
          continue;
        }
        const start = row?.state === "moved" && row.start_at ? row.start_at : at;
        const end = row?.state === "moved" ? (row.end_at ?? (length === null ? null : new Date(start.getTime() + length))) : length === null ? null : new Date(at.getTime() + length);
        const id = randomUUID();
        await tx`INSERT INTO node (id, kind, title, body, occurred_at, source, agent_id) VALUES (${id}, 'plan', ${plan.title}, ${plan.body}, ${start}, ${plan.source}, ${plan.agent_id})`;
        await tx`
          INSERT INTO plan_detail (node_id, end_at, time_zone, rsvp, outcome, outcome_at, actual_start, actual_end)
          VALUES (${id}, ${end}, ${plan.time_zone}, ${plan.hide_from_planner ? "no" : null},
            ${row?.outcome ?? null}, ${row?.outcome_at ?? null}, ${row?.actual_start ?? null}, ${row?.actual_end ?? null})`;
        await tx`INSERT INTO edge (id, src_id, dst_id, type, properties, confidence) VALUES (${randomUUID()}, ${plan.id}, ${id}, 'HAS_SESSION', '{}', 1)`;
        for (const place of places) {
          await tx`INSERT INTO edge (id, src_id, dst_id, type, properties, confidence) VALUES (${randomUUID()}, ${id}, ${place.dst_id}, 'AT_LOCATION', ${tx.json(JSON.parse(JSON.stringify(place.properties)))}, 1)`;
        }
        for (const note of notes.filter((item) => item.properties.occurrence === day)) {
          await tx`INSERT INTO edge (id, src_id, dst_id, type, properties, confidence) VALUES (${randomUUID()}, ${id}, ${note.dst_id}, 'HAS_NOTE', '{}', 1)`;
          await tx`UPDATE edge SET valid_to = now() WHERE id = ${note.id}`;
          counts.notes += 1;
        }
        counts.sessions += 1;
      }
      counts.skippedMoves += overrides.filter((row) => !planned.has(row.occurrence_date)).length;
    }

    const both = await tx<{ id: string; title: string }[]>`
      SELECT n.id, n.title FROM node n JOIN plan_detail d ON d.node_id = n.id WHERE n.kind = 'plan' AND n.occurred_at IS NOT NULL AND d.due_at IS NOT NULL`;
    const routines = await tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM plan_detail WHERE kind IN ('meal', 'shower', 'gym', 'study', 'focus')`;
    console.log(JSON.stringify({ apply, through, ...counts, startAndDue: both, routinePlans: Number(routines[0]?.n ?? 0) }, null, 2));
    if (!apply) {
      throw new DryRun();
    }
  });
} catch (err) {
  if (!(err instanceof DryRun)) {
    throw err;
  }
  console.log("dry run: rolled back");
} finally {
  await client.end();
}
