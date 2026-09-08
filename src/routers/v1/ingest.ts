/** `POST /ingest` — extract and apply memory operations from an utterance. */

import type { FastifyInstance } from "fastify";
import { ingest } from "../../ingest/pipeline.js";
import { ingestBody, parse } from "./schemas.js";

export async function registerIngest(app: FastifyInstance): Promise<void> {
  app.post("/ingest", async (request) => {
    const body = parse(ingestBody, request.body);
    return ingest({
      db: app.db,
      sql: app.sql,
      dwar: app.dwar,
      config: app.config,
      text: body.text,
      occurredAt: body.occurred_at,
      participantIds: body.participant_ids ?? [],
      source: body.source,
    });
  });
}
