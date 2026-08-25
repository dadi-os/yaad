import type { FastifyInstance } from "fastify";
import { registerAdmin } from "./admin.js";
import { registerEdges } from "./edges.js";
import { registerIngest } from "./ingest.js";
import { registerNodes } from "./nodes.js";
import { registerPeople } from "./people.js";
import { registerRecall } from "./recall.js";
import { registerSearch } from "./search.js";
import { registerTimeline } from "./timeline.js";

export async function registerV1(app: FastifyInstance): Promise<void> {
  await registerNodes(app);
  await registerEdges(app);
  await registerTimeline(app);
  await registerPeople(app);
  await registerSearch(app);
  await registerIngest(app);
  await registerRecall(app);
  await registerAdmin(app);
}
