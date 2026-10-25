/**
 * `GET /events` — Server-Sent Events stream that emits `{ type: "changed", at }` after
 * every request that may have written. Clients refetch what they show; the event names
 * no resource, so a write route added later publishes without further wiring.
 */

import type { ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";

const HEARTBEAT_MS = 20_000;

/** POST routes that only read, so they never publish a change. */
const READ_ONLY_POSTS = new Set(["/history/search", "/recall", "/query", "/graph", "/timeline"]);

export async function registerEvents(app: FastifyInstance): Promise<void> {
  const streams = new Set<ServerResponse>();

  app.get("/events", (request, reply) => {
    reply.hijack();
    const stream = reply.raw;
    stream.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    stream.write(": connected\n\n");
    streams.add(stream);
    const heartbeat = setInterval(() => stream.write(": ping\n\n"), HEARTBEAT_MS);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      streams.delete(stream);
    });
  });

  app.addHook("onResponse", async (request, reply) => {
    if (request.method === "GET" || reply.statusCode >= 400) {
      return;
    }
    if (READ_ONLY_POSTS.has(request.url.replace(/\?.*$/, ""))) {
      return;
    }
    const chunk = `data: ${JSON.stringify({ type: "changed", at: new Date().toISOString() })}\n\n`;
    for (const stream of streams) {
      stream.write(chunk);
    }
  });

  app.addHook("onClose", async () => {
    for (const stream of streams) {
      stream.end();
    }
  });
}
