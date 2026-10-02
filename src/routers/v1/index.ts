/** Mount all `/v1` HTTP routes (nodes, edges, history, ingest, recall, query, graph, lint). */

import type { FastifyInstance } from "fastify";
import { registerEdges } from "./edges.js";
import { registerGraph } from "./graph.js";
import { registerHistory } from "./history.js";
import { registerIngest } from "./ingest.js";
import { registerLint } from "./lint.js";
import { registerNodes } from "./nodes.js";
import { registerQuery } from "./query.js";
import { registerRecall } from "./recall.js";

export async function registerV1(app: FastifyInstance): Promise<void> {
  await registerNodes(app);
  await registerEdges(app);
  await registerHistory(app);
  await registerIngest(app);
  await registerRecall(app);
  await registerQuery(app);
  await registerGraph(app);
  await registerLint(app);
}
