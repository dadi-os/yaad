import axios, { type AxiosInstance } from "axios";
import { z } from "zod";
import type { Config } from "../config.js";
import { DWAR_BASE_URL } from "../constants.js";
import { YaadError } from "../errors.js";

const embedResponseSchema = z.object({
  embeddings: z.array(z.array(z.number())),
  dimensions: z.number().int(),
});

const chatBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
]);

const chatResponseSchema = z.object({
  content: z.array(chatBlockSchema),
  stop_reason: z.enum(["end_turn", "tool_use", "max_tokens", "error"]),
});

export type DwarChatResponse = z.infer<typeof chatResponseSchema>;

export type DwarTool = {
  name: string;
  description: string;
  input_schema: object;
};

export function embeddingText(title: string, body: string | null): string {
  return body ? `${title}\n${body}` : title;
}

export type DwarClient = {
  embed: (texts: string[]) => Promise<number[][]>;
  reason: (args: {
    system: string;
    user: string;
    tools: DwarTool[];
  }) => Promise<DwarChatResponse>;
};

export function createDwarClient(config: Config): DwarClient {
  const http: AxiosInstance = axios.create({
    baseURL: DWAR_BASE_URL,
    timeout: config.dwar.timeout_seconds * 1000,
    headers: { "content-type": "application/json" },
  });

  async function embedBatch(texts: string[]): Promise<number[][]> {
    const data = await withRetry(config, () =>
      http.post("/embed", { texts }).then((res) => res.data),
    );
    const parsed = embedResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new YaadError(502, "dwar", "Dwar embed response is malformed");
    }
    if (parsed.data.dimensions !== config.embedding.dimension) {
      throw new YaadError(
        502,
        "dimension_mismatch",
        `Dwar returned ${parsed.data.dimensions}-d embeddings; yaad is configured for ${config.embedding.dimension}`,
      );
    }
    if (parsed.data.embeddings.length !== texts.length) {
      throw new YaadError(502, "dwar", "Dwar embed response count does not match the request");
    }
    for (const [index, vector] of parsed.data.embeddings.entries()) {
      if (vector.length !== config.embedding.dimension) {
        throw new YaadError(
          502,
          "dimension_mismatch",
          `Dwar embedding at index ${index} has width ${vector.length}; yaad is configured for ${config.embedding.dimension}`,
        );
      }
    }
    return parsed.data.embeddings;
  }

  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) {
        throw new YaadError(500, "internal_error", "embed called with no texts");
      }
      const out: number[][] = [];
      const size = config.embedding.batch_size;
      for (let i = 0; i < texts.length; i += size) {
        const chunk = texts.slice(i, i + size);
        const vectors = await embedBatch(chunk);
        out.push(...vectors);
      }
      return out;
    },
    async reason(args): Promise<DwarChatResponse> {
      const data = await withRetry(config, () =>
        http
          .post("/chat/reasoning", {
            system: args.system,
            messages: [{ role: "user", content: args.user }],
            tools: args.tools,
          })
          .then((res) => res.data),
      );
      const parsed = chatResponseSchema.safeParse(data);
      if (!parsed.success) {
        throw new YaadError(502, "dwar", "Dwar chat response is malformed");
      }
      return parsed.data;
    },
  };
}

async function withRetry(config: Config, fn: () => Promise<unknown>): Promise<unknown> {
  const { attempts, backoff_seconds: backoff } = config.dwar;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === attempts - 1) {
        throw mapDwarError(err);
      }
      const delay = backoff[Math.min(attempt, backoff.length - 1)];
      if (delay === undefined) {
        throw mapDwarError(err);
      }
      await sleep(delay * 1000);
    }
  }
  throw mapDwarError(lastError);
}

function isRetryable(err: unknown): boolean {
  if (!axios.isAxiosError(err)) {
    return false;
  }
  if (!err.response) {
    return true;
  }
  return err.response.status >= 500;
}

function mapDwarError(err: unknown): YaadError {
  if (err instanceof YaadError) {
    return err;
  }
  if (axios.isAxiosError(err)) {
    if (!err.response) {
      return new YaadError(502, "upstream_unreachable", "Dwar is unreachable");
    }
    const message = dwarMessage(err.response.data);
    return new YaadError(502, "dwar", message);
  }
  return new YaadError(502, "dwar", "Dwar request failed");
}

function dwarMessage(data: unknown): string {
  if (typeof data === "object" && data !== null && "error" in data) {
    const error = (data as { error: unknown }).error;
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = (error as { message: unknown }).message;
      if (typeof message === "string" && message.length > 0) {
        return message;
      }
    }
  }
  return "Dwar request failed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
