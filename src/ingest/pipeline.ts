/**
 * End-to-end ingest: embed the utterance and its segments → candidates → Dwar extraction,
 * re-run once with any lookalikes the first pass missed, nodes it left without an edge → leave out created tasks that closed before the text's day
 * unless Ankur states it (reported as `skipped`) → bring task opens within bounds (reported as
 * `clamped`) → merge creates that duplicate a live node into updates (reported as `merged`) →
 * validate → apply.
 */

import { inArray } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db, Sql } from "../db/client.js";
import { taskDetail } from "../db/schema.js";
import type { DwarClient } from "../dwar/client.js";
import { YaadError } from "../errors.js";
import type { NodeAuthor } from "../types/domain.js";
import { applyOperations, type ApplyResult } from "./apply.js";
import { assembleCandidates, segmentsOf } from "./candidates.js";
import { findLookalikes, mergeDuplicates, type MergedDuplicate } from "./duplicates.js";
import { emitOperations, recheckNote } from "./emit.js";
import type { Operation } from "./operations.js";
import { clampWindows, pastCloses, unlinkedCreates, validateExtraction, validateOperations, type ClampedWindow, type SkippedTask } from "./validate.js";

/** What a stored batch reports beyond what it applied: windows it moved, closed tasks it left out, creates it merged. */
export type IngestResult = ApplyResult & { clamped: ClampedWindow[]; skipped: SkippedTask[]; merged: MergedDuplicate[] };

/** Extract memory ops from an utterance and apply them in one transaction. */
export async function ingest(opts: {
  db: Db;
  sql: Sql;
  dwar: DwarClient;
  config: Config;
  text: string;
  /** Ankur's own words, verbatim, when the caller has them; what lets a task that closed before the text be stored. */
  sourceText?: string | undefined;
  occurredAt: string;
  participantIds: string[];
  author: NodeAuthor;
}): Promise<IngestResult> {
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
    return { candidates, ...pastCloses(operations, opts.occurredAt, opts.sourceText, timeZone) };
  };

  const first = await extract([], null);
  const missed = await findLookalikes(
    opts.db,
    first.operations,
    new Set(first.candidates.nodes.map((candidate) => candidate.id)),
    timeZone,
  );
  const unlinked = unlinkedCreates(first.operations);
  const extracted =
    missed.length > 0 || unlinked.length > 0
      ? await extract(missed, recheckNote({ lookalikes: missed.length > 0, unlinked }))
      : first;

  const stated = opts.sourceText === undefined ? opts.text : `${opts.text}\n${opts.sourceText}`;
  const storedOpens = await storedTaskOpens(opts.db, extracted.operations);
  const clamp = clampWindows(extracted.operations, { text: stated, occurredAt: opts.occurredAt, timeZone, storedOpens });
  const merge = await mergeDuplicates(opts.db, clamp.operations, timeZone);

  await validateOperations({ db: opts.db, operations: merge.operations, timeZone });
  validateExtraction({ operations: merge.operations, text: opts.text, sourceText: opts.sourceText });
  const applied = await applyOperations({
    db: opts.db,
    dwar: opts.dwar,
    operations: merge.operations,
    author: opts.author,
    config: opts.config,
  });
  return { ...applied, clamped: clamp.clamped, skipped: extracted.skipped, merged: merge.merged };
}

/** The stored open day of each task that an `update_node` in `operations` names; other nodes are absent. */
async function storedTaskOpens(db: Db, operations: Operation[]): Promise<Map<string, string | null>> {
  const ids = operations.flatMap((op) => (op.op === "update_node" ? [op.node_id] : []));
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await db.select({ id: taskDetail.nodeId, opensOn: taskDetail.opensOn }).from(taskDetail).where(inArray(taskDetail.nodeId, ids));
  return new Map(rows.map((row) => [row.id, row.opensOn]));
}
