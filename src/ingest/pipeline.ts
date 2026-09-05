import type { Config } from "../config.js";
import type { Db, Sql } from "../db/client.js";
import type { DwarClient } from "../dwar/client.js";
import { YaadError } from "../errors.js";
import type { NodeSource } from "../types/domain.js";
import { applyOperations, type ApplyResult } from "./apply.js";
import { assembleCandidates } from "./candidates.js";
import { emitOperations } from "./emit.js";
import { validateOperations } from "./validate.js";

export async function ingest(opts: {
  db: Db;
  sql: Sql;
  dwar: DwarClient;
  config: Config;
  text: string;
  occurredAt: string;
  participantIds: string[];
  source: NodeSource;
}): Promise<ApplyResult> {
  const [embedding] = await opts.dwar.embed([opts.text]);
  if (!embedding) {
    throw new YaadError(502, "dwar", "Dwar returned no embedding");
  }
  const candidates = await assembleCandidates({
    db: opts.db,
    sql: opts.sql,
    config: opts.config,
    text: opts.text,
    embedding,
    participantIds: opts.participantIds,
  });
  const operations = await emitOperations({
    dwar: opts.dwar,
    config: opts.config,
    occurredAt: opts.occurredAt,
    text: opts.text,
    candidates,
  });
  await validateOperations({ db: opts.db, operations });
  return applyOperations({
    db: opts.db,
    dwar: opts.dwar,
    operations,
    source: opts.source,
    config: opts.config,
  });
}
