/**
 * `GET /lint` — a read-only report of live nodes that match patterns past audits found
 * wrong: status snapshots, agent working notes and instructions to agents stored as
 * permanent memory, plans at a placeholder noon, dated hubs, periods stored as plans, two
 * series on the same schedule, duplicates, people missing their first-name alias, places
 * plans happen at that have no street address, and nodes with no current edge.
 * It never changes the graph; someone reads the report and fixes what is really wrong.
 */

import { and, asc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { getCurrentPersons } from "../../db/read.js";
import { alias } from "drizzle-orm/pg-core";
import { edge, node, placeDetail, planDetail } from "../../db/schema.js";
import { normalizedTitleSql } from "../../ingest/duplicates.js";
import type { LintFinding } from "../../types/domain.js";

/** Status wording that stops being true: "as of", "not yet", "so far", "still needs", "no … found". */
const STATUS_PATTERN = String.raw`\m(as of|not yet|so far|still needs?|unconfirmed)\M|\mno\M.{0,60}\m(found|posted|yet)\M`;
/** Wording of an agent's own plumbing and how-to (paths, branches, wakes, stored credentials, site and tool lessons) rather than facts about Ankur's world. */
const WORKING_NOTE_PATTERN = String.raw`/var/lib|\mworktree|\mbranch\M|\mcommit\M|this agent|\mwake\M|credentials? (set up|exist|stored)|\mchaavi\M|site lesson|\mhow-to\M|shadow dom|\mdom\M|\mref [a-z]\d|accessibility tree|browser (task|helper)|terminal (task|helper)|steer_(browser|terminal)|\.(tsx?|py|go|aspx)\M|\mline \d+`;
/** Wording of a rule for how agents work ("no agent may submit", "Ankur wants agents to"), which belongs in a charter. */
const AGENT_INSTRUCTION_PATTERN = String.raw`\mno agents? (may|should|can)\M|\magents? (must|should|may) (never|not|always|only)\M|\mwants (the )?(agents?|dadi|specialists?) to\M|\m(specialists?|managers?|helpers?) (must|should) (never|always)\M`;
/** A full street address holds a building number and a street ("428 S Shaw Ln, East Lansing, MI"). */
const STREET_NUMBER_PATTERN = String.raw`\m\d+[A-Za-z]?\s+[A-Za-z]`;
/** A plan spanning more than this is usually a period that is a rule (a drop period, an appointment term), not something Ankur does. */
const LONG_SPAN = "7 days";

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
        note: "Reads as an agent's working note or how-to (paths, branches, wakes, credentials, how a site or tool behaves) rather than a fact about Ankur's world; delete it.",
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

    const instructions = await app.db
      .select({ id: node.id, title: node.title })
      .from(node)
      .where(and(eq(node.kind, "memory"), live, sql`${text} ~* ${AGENT_INSTRUCTION_PATTERN}`))
      .orderBy(asc(node.createdAt));
    for (const row of instructions) {
      findings.push({
        rule: "agent_instruction",
        node_ids: [row.id],
        title: row.title,
        note: "Reads as a rule for how agents work; move it into the owning agent's charter and delete it.",
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

    const spans = await app.db
      .select({ id: node.id, title: node.title })
      .from(node)
      .innerJoin(planDetail, eq(planDetail.nodeId, node.id))
      .where(and(live, isNull(planDetail.recurrence), sql`${planDetail.endAt} - ${node.occurredAt} > ${LONG_SPAN}::interval`))
      .orderBy(asc(node.occurredAt));
    for (const row of spans) {
      findings.push({
        rule: "long_span",
        node_ids: [row.id],
        title: row.title,
        note: "Spans more than a week, which is usually a period that is a rule; make it a facet of its hub and keep only a deadline Ankur must act by as a plan.",
      });
    }

    const series = await app.db
      .select({
        ids: sql<string[]>`array_agg(${node.id} ORDER BY ${node.createdAt})`,
        title: sql<string>`min(${node.title})`,
      })
      .from(node)
      .innerJoin(planDetail, eq(planDetail.nodeId, node.id))
      .where(and(live, isNotNull(planDetail.recurrence)))
      .groupBy(planDetail.recurrence, node.occurredAt)
      .having(sql`count(*) > 1`);
    for (const group of series) {
      findings.push({
        rule: "duplicate_series",
        node_ids: group.ids,
        title: group.title,
        note: "Two recurring plans share a rule and a first meeting, so every meeting shows twice; keep the course hub's series and drop the other's rule.",
      });
    }

    const startHour = sql`CASE WHEN ${node.kind} = 'plan' THEN date_trunc('hour', COALESCE(${node.occurredAt}, ${planDetail.dueAt})) END`;
    const groups = await app.db
      .select({
        ids: sql<string[]>`array_agg(${node.id} ORDER BY ${node.createdAt})`,
        title: sql<string>`min(${node.title})`,
      })
      .from(node)
      .leftJoin(planDetail, eq(planDetail.nodeId, node.id))
      .where(live)
      .groupBy(node.kind, normalizedTitleSql, startHour)
      .having(sql`count(*) > 1`);
    for (const group of groups) {
      findings.push({
        rule: "duplicate",
        node_ids: group.ids,
        title: group.title,
        note: "Same kind and normalized title (plans in the same hour); keep the one with more edges, move the others' edges to it, and delete them.",
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

    const venue = alias(node, "venue");
    const located = await app.db
      .select({
        id: venue.id,
        title: venue.title,
        plans: sql<string[]>`array_agg(DISTINCT ${node.id})`,
      })
      .from(edge)
      .innerJoin(node, eq(node.id, edge.srcId))
      .innerJoin(venue, eq(venue.id, edge.dstId))
      .innerJoin(placeDetail, eq(placeDetail.nodeId, venue.id))
      .where(
        and(
          eq(edge.type, "AT_LOCATION"),
          isNull(edge.validTo),
          eq(node.kind, "plan"),
          live,
          sql`(${placeDetail.address} IS NULL OR ${placeDetail.address} !~ ${STREET_NUMBER_PATTERN})`,
        ),
      )
      .groupBy(venue.id, venue.title)
      .orderBy(asc(venue.title));
    for (const row of located) {
      findings.push({
        rule: "place_without_address",
        node_ids: [row.id, ...row.plans],
        title: row.title,
        note: `${row.plans.length} plan(s) happen here, but the place has no full street address, so directions cannot open; set place_detail.address (the room goes on the AT_LOCATION edge).`,
      });
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
