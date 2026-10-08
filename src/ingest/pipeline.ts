/**
 * End-to-end ingest: embed the utterance and its segments → candidates → Dwar extraction,
 * re-run once with any lookalikes the first pass missed or nodes it left without an
 * edge → validate → apply.
 */

import type { Config } from "../config.js";
import type { Db, Sql } from "../db/client.js";
import type { DwarClient } from "../dwar/client.js";
import { YaadError } from "../errors.js";
import type { NodeAuthor } from "../types/domain.js";
import { applyOperations, type ApplyResult } from "./apply.js";
import { assembleCandidates, segmentsOf } from "./candidates.js";
import { findLookalikes } from "./duplicates.js";
import { emitOperations, recheckNote } from "./emit.js";
import { unlinkedCreates, validateExtraction, validateOperations } from "./validate.js";

/** Extract memory ops from an utterance and apply them in one transaction. */
export async function ingest(opts: {
  db: Db;
  sql: Sql;
  dwar: DwarClient;
  config: Config;
  text: string;
  occurredAt: string;
  participantIds: string[];
  author: NodeAuthor;
}): Promise<ApplyResult> {
  const segments = segmentsOf(opts.text, opts.config.ingest.segment_limit);
  const vectors = await opts.dwar.embed([opts.text, ...segments], "yaad/ingest");
  const [embedding, ...segmentEmbeddings] = vectors;
  if (!embedding || vectors.length !== segments.length + 1) {
    throw new YaadError(502, "dwar", `Dwar returned ${vectors.length} embeddings for ${segments.length + 1} texts`);
  }
  const extract = async (extraIds: string[], recheck: string | null) => {
    const candidates = await assembleCandidates({
      db: opts.db,
      sql: opts.sql,
      config: opts.config,
      text: opts.text,
      embedding,
      segmentEmbeddings,
      participantIds: opts.participantIds,
      extraIds,
    });
    const operations = await emitOperations({
      dwar: opts.dwar,
      config: opts.config,
      occurredAt: opts.occurredAt,
      text: opts.text,
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
  );
  const unlinked = unlinkedCreates(first.operations);
  const { operations } =
    missed.length > 0 || unlinked.length > 0
      ? await extract(missed, recheckNote({ lookalikes: missed.length > 0, unlinked }))
      : first;

  await validateOperations({ db: opts.db, operations });
  await validateExtraction({ db: opts.db, operations, text: opts.text });
  return applyOperations({
    db: opts.db,
    dwar: opts.dwar,
    operations,
    author: opts.author,
    config: opts.config,
  });
}
