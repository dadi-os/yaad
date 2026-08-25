import { inArray } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db, Sql } from "../db/client.js";
import { annSearch } from "../db/ann.js";
import { getCurrentPersons, getIncidentEdgesForIds, getNodesByIds } from "../db/read.js";
import { personDetail, planDetail, type NodeRow, type PersonDetailRow, type PlanDetailRow } from "../db/schema.js";
import { YaadError } from "../errors.js";
import { toEdgeRecord, toNodeRecord, toPersonDetail, toPlanDetail } from "../serialize.js";
import type { EdgeRecord, NodeRecord, PersonDetail, PlanDetail } from "../types/domain.js";

export type CandidateNode = NodeRecord & {
  detail: PersonDetail | PlanDetail | null;
};

export type CandidateState = {
  nodes: CandidateNode[];
  edges: EdgeRecord[];
};

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
    const named = await getNodesByIds(opts.db, opts.participantIds, undefined);
    const found = new Set(named.map((row) => row.id));
    for (const id of opts.participantIds) {
      if (!found.has(id)) {
        throw new YaadError(422, "invalid_request", `participant ${id} is not a current node`);
      }
    }
    for (const row of named) {
      byId.set(row.id, row);
    }
  }

  const nodes = [...byId.values()];
  const ids = nodes.map((row) => row.id);
  const incident = await getIncidentEdgesForIds(opts.db, ids, undefined);
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
): Promise<Map<string, PersonDetail | PlanDetail>> {
  const out = new Map<string, PersonDetail | PlanDetail>();
  const personIds = nodes.filter((row) => row.kind === "person").map((row) => row.id);
  const planIds = nodes.filter((row) => row.kind === "plan").map((row) => row.id);
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
  return out;
}
