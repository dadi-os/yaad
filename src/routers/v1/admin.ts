import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { node } from "../../db/schema.js";
import { embeddingText } from "../../dwar/client.js";
import { YaadError } from "../../errors.js";

export async function registerAdmin(app: FastifyInstance): Promise<void> {
  app.post("/admin/backfill-embeddings", async () => {
    const rows = await app.db
      .select({
        id: node.id,
        validFrom: node.validFrom,
        title: node.title,
        body: node.body,
      })
      .from(node)
      .where(and(isNull(node.validTo), isNull(node.embedding)));

    let updated = 0;
    const size = app.config.embedding.batch_size;
    for (let i = 0; i < rows.length; i += size) {
      const chunk = rows.slice(i, i + size);
      const vectors = await app.dwar.embed(chunk.map((row) => embeddingText(row.title, row.body)));
      await app.db.transaction(async (tx) => {
        for (let j = 0; j < chunk.length; j++) {
          const row = chunk[j];
          const embedding = vectors[j];
          if (!row || !embedding) {
            throw new YaadError(500, "internal", "backfill batch length mismatch");
          }
          await tx
            .update(node)
            .set({ embedding })
            .where(and(eq(node.id, row.id), eq(node.validFrom, row.validFrom), isNull(node.validTo)));
          updated += 1;
        }
      });
    }

    return { updated };
  });
}
