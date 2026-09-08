/** Mount all `/v1` HTTP routes (nodes, history, ingest, recall, query). */

import type { FastifyInstance } from "fastify";
import { registerHistory } from "./history.js";
import { registerIngest } from "./ingest.js";
import { registerNodes } from "./nodes.js";
import { registerQuery } from "./query.js";
import { registerRecall } from "./recall.js";

export async function registerV1(app: FastifyInstance): Promise<void> {
  await registerNodes(app);
  await registerHistory(app);
  await registerIngest(app);
  await registerRecall(app);
  await registerQuery(app);
}
