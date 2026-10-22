import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import Fastify from "fastify";
import { registerEvents } from "../src/routers/v1/events.js";

test("a successful write publishes one change to stream subscribers, reads and failed writes publish none", async (t) => {
  const app = Fastify();
  await registerEvents(app);
  app.get("/things", async () => ({ ok: true }));
  app.post("/things", async () => ({ ok: true }));
  app.post("/recall", async () => ({ ok: true }));
  app.post("/broken", async (_request, reply) => reply.status(422).send({ error: "no" }));
  await app.listen({ port: 0, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

  const res = await fetch(`${url}/events`);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body!.getReader();
  t.after(async () => {
    await reader.cancel();
    await app.close();
  });
  const decoder = new TextDecoder();
  let received = "";
  void (async () => {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      received += decoder.decode(chunk.value);
    }
  })();

  await fetch(`${url}/things`);
  await fetch(`${url}/recall`, { method: "POST" });
  await fetch(`${url}/broken`, { method: "POST" });
  await fetch(`${url}/things`, { method: "POST" });
  await sleep(50);

  const events = received.split("\n\n").filter((part) => part.startsWith("data: "));
  assert.equal(events.length, 1);
  assert.equal(JSON.parse(events[0]!.slice(6)).type, "changed");
});
