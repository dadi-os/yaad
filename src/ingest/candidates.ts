/** Assemble ANN + name-match + participant context for Dwar extraction. */

import { inArray } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db, Sql } from "../db/client.js";
import { annSearch } from "../db/ann.js";
import { getCurrentPersons, getIncidentEdgesForIds, getNode } from "../db/read.js";
import {
  personDetail,
  placeDetail,
  planDetail,
  type NodeRow,
  type PersonDetailRow,
  type PlaceDetailRow,
  type PlanDetailRow,
} from "../db/schema.js";
import { YaadError } from "../errors.js";
import { toEdgeRecord, toNodeRecord, toPersonDetail, toPlaceDetail, toPlanDetail } from "../serialize.js";
import type { EdgeRecord, NodeRecord, PersonDetail, PlaceDetail, PlanDetail } from "../types/domain.js";
import { isExpired } from "./expiry.js";

export type CandidateNode = NodeRecord & {
  detail: PersonDetail | PlanDetail | PlaceDetail | null;
};

export type CandidateState = {
  nodes: CandidateNode[];
  edges: EdgeRecord[];
};

/**
 * Build the candidate graph shown to extraction: similar live nodes, person
 * alias hits in the utterance text, and explicit participant ids.
 */
export async function assembleCandidates(opts: {
  db: Db;
  sql: Sql;
  config: Config;
  text: string;
  embedding: number[];
  participantIds: string[];
}): Promise<CandidateState> {
  const byId = new Map<string, NodeRow>();

  const hits = await annSearch({
    sql: opts.sql,
    efSearch: opts.config.hnsw.ef_search,
    embedding: opts.embedding,
    limit: opts.config.ingest.candidate_limit,
  });
  for (const hit of hits) {
    if (hit.similarity >= opts.config.ingest.candidate_similarity_floor) {
      byId.set(hit.row.id, hit.row);
    }
  }

  const persons = await getCurrentPersons(opts.db);
  const haystack = opts.text.toLowerCase();
  for (const person of persons) {
    const names = [person.node.title, ...person.detail.aliases];
    if (names.some((name) => name.length >= 2 && haystack.includes(name.toLowerCase()))) {
      byId.set(person.node.id, person.node);
    }
  }

  if (opts.participantIds.length > 0) {
    for (const id of opts.participantIds) {
      let row;
      try {
        row = await getNode(opts.db, id);
      } catch (err) {
        if (err instanceof YaadError && err.statusCode === 404) {
          throw new YaadError(422, "invalid_request", `participant ${id} is not a current node`);
        }
        throw err;
      }
      if (isExpired(row.expiresAt)) {
        throw new YaadError(422, "invalid_request", `participant ${id} has expired`);
      }
      byId.set(row.id, row);
    }
  }

  const nodes = [...byId.values()];
  const ids = nodes.map((row) => row.id);
  const incident = await getIncidentEdgesForIds(opts.db, ids);
  const idSet = new Set(ids);
  const between = incident.filter((edge) => idSet.has(edge.srcId) && idSet.has(edge.dstId));
  const rest = incident.filter((edge) => !(idSet.has(edge.srcId) && idSet.has(edge.dstId)));
  const edges = [...between, ...rest].slice(0, opts.config.ingest.edge_context_limit);

  const details = await loadDetails(opts.db, nodes);
  return {
    nodes: nodes.map((row) => {
      const extra = details.get(row.id);
      return {
        ...toNodeRecord(row),
        detail: extra ?? null,
      };
    }),
    edges: edges.map(toEdgeRecord),
  };
}

async function loadDetails(
  db: Db,
  nodes: NodeRow[],
): Promise<Map<string, PersonDetail | PlanDetail | PlaceDetail>> {
  const out = new Map<string, PersonDetail | PlanDetail | PlaceDetail>();
  const personIds = nodes.filter((row) => row.kind === "person").map((row) => row.id);
  const planIds = nodes.filter((row) => row.kind === "plan").map((row) => row.id);
  const placeIds = nodes.filter((row) => row.kind === "place").map((row) => row.id);
  if (personIds.length > 0) {
    const rows: PersonDetailRow[] = await db
      .select()
      .from(personDetail)
      .where(inArray(personDetail.nodeId, personIds));
    for (const row of rows) {
      out.set(row.nodeId, toPersonDetail(row));
    }
  }
  if (planIds.length > 0) {
    const rows: PlanDetailRow[] = await db
      .select()
      .from(planDetail)
      .where(inArray(planDetail.nodeId, planIds));
    for (const row of rows) {
      out.set(row.nodeId, toPlanDetail(row));
    }
  }
  if (placeIds.length > 0) {
    const rows: PlaceDetailRow[] = await db
      .select()
      .from(placeDetail)
      .where(inArray(placeDetail.nodeId, placeIds));
    for (const row of rows) {
      out.set(row.nodeId, toPlaceDetail(row));
    }
  }
  return out;
}
