/**
 * End-to-end ingest: embed the utterance and its segments → candidates → Dwar extraction,
 * re-run once with any lookalikes the first pass missed, nodes it left without an edge or edge types it may not use →
 * validate → apply. Nothing the model extracted is changed in code.
 */

import type { Config } from "../config.js";
import type { Db, Sql } from "../db/client.js";
import type { DwarClient } from "../dwar/client.js";
import { YaadError } from "../errors.js";
import type { AgentAuthor } from "../types/domain.js";
import { applyOperations, type ApplyResult } from "./apply.js";
import { assembleCandidates, segmentsOf } from "./candidates.js";
import { findLookalikes } from "./duplicates.js";
import { emitOperations, recheckNote } from "./emit.js";
import { unknownEdgeTypes, unlinkedCreates, validateExtraction, validateOperations } from "./validate.js";

/** Extract memory ops from an utterance and apply them in one transaction. */
export async function ingest(opts: {
  db: Db;
  sql: Sql;
  dwar: DwarClient;
  config: Config;
  text: string;
  /** Ankur's own words, verbatim, when the caller has them; what a `close_node` may quote beside the text. */
  sourceText?: string | undefined;
  occurredAt: string;
  participantIds: string[];
  author: AgentAuthor;
}): Promise<ApplyResult> {
  const segments = segmentsOf(opts.text, opts.config.ingest.segment_limit);
  const vectors = await opts.dwar.embed([opts.text, ...segments], "yaad/ingest");
  const [embedding, ...segmentEmbeddings] = vectors;
  if (!embedding || vectors.length !== segments.length + 1) {
    throw new YaadError(502, "dwar", `Dwar returned ${vectors.length} embeddings for ${segments.length + 1} texts`);
  }
  const timeZone = opts.config.env.timezone;
  const extract = async (extraIds: string[], recheck: string | null) => {
    const candidates = await assembleCandidates({
      db: opts.db,
      sql: opts.sql,
      config: opts.config,
      text: opts.text,
      embedding,
      segmentEmbeddings,
      participantIds: opts.participantIds,
      author: opts.author,
      extraIds,
    });
    const operations = await emitOperations({
      dwar: opts.dwar,
      config: opts.config,
      occurredAt: opts.occurredAt,
      text: opts.text,
      sourceText: opts.sourceText,
      candidates,
      recheck,
    });
    return { candidates, operations };
  };

  const first = await extract([], null);
  const missed = await findLookalikes(
    opts.db,
    first.operations,
    new Set(first.candidates.nodes.map((candidate) => candidate.id)),
    timeZone,
  );
  const unlinked = unlinkedCreates(first.operations);
  const edgeTypes = unknownEdgeTypes(first.operations);
  const extracted =
    missed.length > 0 || unlinked.length > 0 || edgeTypes.length > 0
      ? await extract(missed, recheckNote({ lookalikes: missed.length > 0, unlinked, edgeTypes }))
      : first;

  await validateOperations({ db: opts.db, operations: extracted.operations, timeZone });
  validateExtraction({ operations: extracted.operations, text: opts.text, sourceText: opts.sourceText });
  return applyOperations({
    db: opts.db,
    dwar: opts.dwar,
    operations: extracted.operations,
    author: opts.author,
    config: opts.config,
  });
}
