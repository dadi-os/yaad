/** Writes to `plan_occurrence`: what happened to one session of a plan. */

import { and, eq, gt, isNull, or } from "drizzle-orm";
import { YaadError } from "../errors.js";
import { sessionOn } from "../ingest/recurrence.js";
import type { OccurrenceState, Outcome } from "../types/timeline.js";
import { node, planDetail, planOccurrence, type PlanOccurrenceRow } from "./schema.js";
import type { Tx } from "./temporal.js";

/** What a write changes on one session; a field left undefined keeps its value and null clears it. */
export type OccurrenceChange = {
  state?: OccurrenceState | undefined;
  /** New start of a moved session. */
  startAt?: Date | undefined;
  /** New end of a moved session; left out, the session keeps its plan's length. */
  endAt?: Date | null | undefined;
  outcome?: Outcome | null | undefined;
  actualStart?: Date | null | undefined;
  actualEnd?: Date | null | undefined;
};

/**
 * Apply `change` to the session of plan `planId` first scheduled on the local `date`, as
 * `source` (a Hath agent id, `manual`, or `ingest`). A session back to its plan's times with no
 * outcome and no actual times has its row removed, so a row exists only while it differs.
 * Returns the row, or null when none is left.
 * @throws 404 `not_found` for an unknown or expired plan; 422 `invalid_request` when the plan has
 * no session that day or a moved session has no start.
 */
export async function writeOccurrence(
  tx: Tx,
  opts: {
    planId: string;
    date: string;
    change: OccurrenceChange;
    source: string;
    calendar: { timeZone: string; maxInstances: number };
    at: Date;
  },
): Promise<PlanOccurrenceRow | null> {
  const [plan] = await tx
    .select({ node, detail: planDetail })
    .from(node)
    .innerJoin(planDetail, eq(planDetail.nodeId, node.id))
    .where(and(eq(node.id, opts.planId), or(isNull(node.expiresAt), gt(node.expiresAt, opts.at))))
    .for("update");
  if (!plan) {
    throw new YaadError(404, "not_found", `plan ${opts.planId} not found`);
  }
  const session = sessionOn(
    {
      start: plan.node.occurredAt,
      end: plan.detail.endAt,
      due: plan.detail.dueAt,
      opens: plan.detail.opensAt,
      rule: plan.detail.recurrence,
    },
    opts.date,
    opts.calendar,
  );
  if (!session) {
    throw new YaadError(422, "invalid_request", `plan ${opts.planId} "${plan.node.title}" has no session on ${opts.date}`);
  }
  const key = and(eq(planOccurrence.planId, opts.planId), eq(planOccurrence.occurrenceDate, opts.date));
  const [current] = await tx.select().from(planOccurrence).where(key).for("update");
  const { change } = opts;

  const state = change.state ?? current?.state ?? "scheduled";
  let startAt: Date | null = null;
  let endAt: Date | null = null;
  if (state === "moved") {
    const keptStart = current?.state === "moved" ? current.startAt : null;
    startAt = change.startAt ?? keptStart;
    if (startAt === null) {
      throw new YaadError(422, "invalid_request", `moving the ${opts.date} session of "${plan.node.title}" needs start_at`);
    }
    const length = session.start !== null && session.end !== null ? session.end.getTime() - session.start.getTime() : null;
    endAt =
      change.endAt !== undefined
        ? change.endAt
        : change.startAt === undefined && current?.state === "moved"
          ? current.endAt
          : length === null
            ? null
            : new Date(startAt.getTime() + length);
  }
  const outcome = change.outcome !== undefined ? change.outcome : (current?.outcome ?? null);
  const outcomeAt =
    outcome === null ? null : outcome === current?.outcome ? current.outcomeAt : opts.at;
  const actualStart = change.actualStart !== undefined ? change.actualStart : (current?.actualStart ?? null);
  const actualEnd = change.actualEnd !== undefined ? change.actualEnd : (current?.actualEnd ?? null);

  if (state === "scheduled" && outcome === null && actualStart === null && actualEnd === null) {
    if (current) {
      await tx.delete(planOccurrence).where(key);
    }
    return null;
  }
  const row: PlanOccurrenceRow = {
    planId: opts.planId,
    occurrenceDate: opts.date,
    state,
    startAt,
    endAt,
    outcome,
    outcomeAt,
    actualStart,
    actualEnd,
    source: opts.source,
    updatedAt: opts.at,
  };
  await tx
    .insert(planOccurrence)
    .values(row)
    .onConflictDoUpdate({ target: [planOccurrence.planId, planOccurrence.occurrenceDate], set: row });
  return row;
}
