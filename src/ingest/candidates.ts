/** Assemble the context Dwar extraction sees: ANN over the whole text and each segment, people named in it, participants, and lookalikes. */

import { inArray } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db, Sql } from "../db/client.js";
import { annSearch } from "../db/ann.js";
import { getCurrentPersons, getIncidentEdgesForIds, getNode, getNodesByIds } from "../db/read.js";
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

/** Shortest line or sentence searched on its own; shorter fragments carry too little to match. */
const MIN_SEGMENT_CHARS = 12;

/**
 * segmentsOf splits an utterance into its lines and sentences so each item in a long,
 * multi-topic text gets its own nearest-neighbor search. Returns nothing for a single
 * segment (the whole-text search already covers it) and merges neighbors evenly when
 * there are more than `limit`.
 */
export function segmentsOf(text: string, limit: number): string[] {
  const parts = text
    .split(/\n+|(?<=[.!?;])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= MIN_SEGMENT_CHARS);
  if (parts.length <= 1) {
    return [];
  }
  if (parts.length <= limit) {
    return parts;
  }
  const size = Math.ceil(parts.length / limit);
  const merged: string[] = [];
  for (let i = 0; i < parts.length; i += size) {
    merged.push(parts.slice(i, i + size).join(" "));
  }
  return merged;
}

/**
 * Names a person may be written as: their title, their aliases, and each capitalized word
 * of the title at least three letters long (a first or last name). Agents write "Ankur",
 * not "Ankur Desai", so the title alone would miss them.
 */
function personNames(title: string, aliases: string[]): string[] {
  const words = title
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}'-]/gu, ""))
    .filter((word) => word.length >= 3 && /^\p{Lu}/u.test(word));
  return [title, ...aliases, ...words].filter((name) => name.length >= 2);
}

/** True when `name` appears in `text` as a whole word or phrase, ignoring case. */
function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

/**
 * Build the candidate graph shown to extraction: live nodes near the whole utterance and
 * near each of its segments, every person named in the text, explicit participant ids,
 * and `extraIds` (lookalikes found after a first extraction, see findLookalikes).
 */
export async function assembleCandidates(opts: {
  db: Db;
  sql: Sql;
  config: Config;
  text: string;
  embedding: number[];
  /** One embedding per entry of segmentsOf(text), in the same order. */
  segmentEmbeddings: number[][];
  participantIds: string[];
  extraIds: string[];
}): Promise<CandidateState> {
  const byId = new Map<string, NodeRow>();

  const searches = [
    { embedding: opts.embedding, limit: opts.config.ingest.candidate_limit },
    ...opts.segmentEmbeddings.map((embedding) => ({
      embedding,
      limit: opts.config.ingest.segment_candidate_limit,
    })),
  ];
  for (const search of searches) {
    const hits = await annSearch({
      sql: opts.sql,
      efSearch: opts.config.hnsw.ef_search,
      embedding: search.embedding,
      limit: search.limit,
    });
    for (const hit of hits) {
      if (hit.similarity >= opts.config.ingest.candidate_similarity_floor) {
        byId.set(hit.row.id, hit.row);
      }
    }
  }

  const persons = await getCurrentPersons(opts.db);
  for (const person of persons) {
    if (personNames(person.node.title, person.detail.aliases).some((name) => mentions(opts.text, name))) {
      byId.set(person.node.id, person.node);
    }
  }

  for (const row of await getNodesByIds(opts.db, opts.extraIds)) {
    byId.set(row.id, row);
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
