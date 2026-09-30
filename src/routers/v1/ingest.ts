/** `POST /ingest` — extract and apply memory operations from an utterance; logs any orphans the batch swept. */

import type { FastifyInstance } from "fastify";
import { ingest } from "../../ingest/pipeline.js";
import { ingestBody, parse } from "./schemas.js";

export async function registerIngest(app: FastifyInstance): Promise<void> {
  app.post("/ingest", async (request) => {
    const body = parse(ingestBody, request.body);
    const result = await ingest({
      db: app.db,
      sql: app.sql,
      dwar: app.dwar,
      config: app.config,
      text: body.text,
      occurredAt: body.occurred_at,
      participantIds: body.participant_ids ?? [],
      author:
        body.source === "agent"
          ? { source: "agent", agentId: body.agent_id }
          : { source: "ingest", agentId: null },
    });
    if (result.orphans.length > 0) {
      request.log.info({ request_id: request.requestId, node_ids: result.orphans }, "orphans swept");
    }
    return result;
  });
}
