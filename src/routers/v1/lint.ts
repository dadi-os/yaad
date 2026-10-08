/**
 * `GET /lint` — a read-only report of live nodes that match patterns past audits found
 * wrong: status snapshots and agent working notes stored as permanent memory, plans at a
 * placeholder noon, dated hubs, duplicates, people missing their first-name alias, and
 * nodes with no current edge.
 * It never changes the graph; someone reads the report and fixes what is really wrong.
 */

import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { getCurrentPersons } from "../../db/read.js";
import { edge, node, planDetail } from "../../db/schema.js";
import { normalizedTitleSql } from "../../ingest/duplicates.js";
import type { LintFinding } from "../../types/domain.js";

/** Status wording that stops being true: "as of", "not yet", "so far", "still needs", "no … found". */
const STATUS_PATTERN = String.raw`\m(as of|not yet|so far|still needs?|unconfirmed)\M|\mno\M.{0,60}\m(found|posted|yet)\M`;
/** Wording of an agent's own progress and plumbing (paths, branches, wakes, stored credentials) rather than facts or site lessons about Ankur's world. */
const WORKING_NOTE_PATTERN = String.raw`/var/lib|\mworktree|\mbranch\M|\mcommit\M|this agent|\mwake\M|credentials? (set up|exist|stored)|\mchaavi\M`;

/** Register `GET /lint`. */
export async function registerLint(app: FastifyInstance): Promise<void> {
  app.get("/lint", async () => {
    const live = or(isNull(node.expiresAt), gt(node.expiresAt, new Date()));
    const text = sql`(${node.title} || ' ' || coalesce(${node.body}, ''))`;
    const findings: LintFinding[] = [];

    const snapshots = await app.db
      .select({ id: node.id, title: node.title })
      .from(node)
      .where(and(eq(node.kind, "memory"), isNull(node.expiresAt), sql`${text} ~* ${STATUS_PATTERN}`))
      .orderBy(asc(node.createdAt));
    for (const row of snapshots) {
      findings.push({
        rule: "status_snapshot",
        node_ids: [row.id],
        title: row.title,
        note: "Reads as a status snapshot but never expires; delete it, or date it and give it ttl_days.",
      });
    }

    const notes = await app.db
      .select({ id: node.id, title: node.title })
      .from(node)
      .where(and(eq(node.kind, "memory"), live, sql`${text} ~* ${WORKING_NOTE_PATTERN}`))
      .orderBy(asc(node.createdAt));
    for (const row of notes) {
      findings.push({
        rule: "working_note",
        node_ids: [row.id],
        title: row.title,
        note: "Reads as an agent's working note (paths, branches, wakes, credentials) rather than a fact or lesson about Ankur's world; delete it.",
      });
    }

    const noon = await app.db
      .select({ id: node.id, title: node.title })
      .from(node)
      .innerJoin(planDetail, eq(planDetail.nodeId, node.id))
      .where(
        and(
          live,
          eq(planDetail.allDay, false),
          isNotNull(node.occurredAt),
          sql`to_char(${node.occurredAt} AT TIME ZONE ${app.config.env.timezone}, 'HH24:MI:SS') = '12:00:00'`,
        ),
      )
      .orderBy(asc(node.occurredAt));
    for (const row of noon) {
      findings.push({
        rule: "noon_placeholder",
        node_ids: [row.id],
        title: row.title,
        note: "Starts at exactly noon, the old placeholder for an unstated time; set the real time or make it all_day.",
      });
    }

    const ownsItems = sql`EXISTS (SELECT 1 FROM ${edge} WHERE ${edge.srcId} = ${node.id} AND ${edge.validTo} IS NULL AND ${edge.type} = 'HAS_ITEM')`;
    const hubs = await app.db
      .select({ id: node.id, title: node.title })
      .from(node)
      .innerJoin(planDetail, eq(planDetail.nodeId, node.id))
      .where(
        and(
          live,
          isNotNull(node.occurredAt),
          isNull(planDetail.recurrence),
          ownsItems,
        ),
      );
    for (const row of hubs) {
      findings.push({
        rule: "dated_hub",
        node_ids: [row.id],
        title: row.title,
        note: "A hub that owns dated items (HAS_ITEM) carries a single date, often copied from one of them; a hub's date comes only from its own schedule.",
      });
    }

    const startHour = sql`CASE WHEN ${node.kind} = 'plan' THEN date_trunc('hour', ${node.occurredAt}) END`;
    const groups = await app.db
      .select({
        ids: sql<string[]>`array_agg(${node.id} ORDER BY ${node.createdAt})`,
        title: sql<string>`min(${node.title})`,
      })
      .from(node)
      .where(and(inArray(node.kind, ["memory", "plan"]), live))
      .groupBy(node.kind, normalizedTitleSql, startHour)
      .having(sql`count(*) > 1`);
    for (const group of groups) {
      findings.push({
        rule: "duplicate",
        node_ids: group.ids,
        title: group.title,
        note: "Same kind and normalized title (plans in the same hour); keep the one with more edges and delete the rest.",
      });
    }

    for (const person of await getCurrentPersons(app.db)) {
      const first = person.node.title.match(/^(\S{3,})\s/)?.[1];
      const aliases = person.detail.aliases.map((alias) => alias.toLowerCase());
      if (first !== undefined && !aliases.includes(first.toLowerCase())) {
        findings.push({
          rule: "unaliased_person",
          node_ids: [person.node.id],
          title: person.node.title,
          note: `"${first}" is not an alias, so a text that says only "${first}" may not reach this person.`,
        });
      }
    }

    const floating = await app.db
      .select({ id: node.id, title: node.title })
      .from(node)
      .where(
        and(
          live,
          sql`NOT EXISTS (SELECT 1 FROM ${edge} WHERE (${edge.srcId} = ${node.id} OR ${edge.dstId} = ${node.id}) AND ${edge.validTo} IS NULL)`,
        ),
      )
      .orderBy(asc(node.createdAt));
    for (const row of floating) {
      findings.push({
        rule: "floating",
        node_ids: [row.id],
        title: row.title,
        note: "Has no current edge, so recall only reaches it by similarity; link it to its subject, hub, or Ankur, or delete it.",
      });
    }

    return { findings };
  });
}
