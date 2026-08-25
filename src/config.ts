/** Typed process config. The only module that reads the environment or config.toml. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

const serviceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tomlPath = join(serviceRoot, "config.toml");

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "must not be empty"),
  DWAR_BASE_URL: z.string().url(),
  HOST: z.string().min(1, "must not be empty"),
  PORT: z.coerce.number().int().min(1).max(65535),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]),
});

const fileSchema = z.object({
  embedding: z.object({
    dimension: z.number().int().positive(),
    batch_size: z.number().int().positive(),
  }),
  hnsw: z.object({
    ef_search: z.number().int().positive(),
  }),
  page: z.object({
    default_size: z.number().int().positive(),
    max_size: z.number().int().positive(),
  }),
  search: z.object({
    default_limit: z.number().int().positive(),
    max_limit: z.number().int().positive(),
  }),
  dwar: z.object({
    timeout_seconds: z.number().positive(),
    attempts: z.number().int().positive(),
    backoff_seconds: z.array(z.number().min(0)).nonempty(),
  }),
  ingest: z.object({
    candidate_similarity_floor: z.number().min(0).max(2),
    candidate_limit: z.number().int().positive(),
    edge_context_limit: z.number().int().positive(),
  }),
  recall: z.object({
    anchor_similarity_floor: z.number().min(0).max(2),
    anchor_limit: z.number().int().positive(),
    hop_cap: z.number().int().min(0),
    relevance_threshold: z.number(),
    marginal_yield_minimum: z.number().int().min(0),
    token_budget: z.number().int().positive(),
    coverage_top_n: z.number().int().positive(),
    coverage_floor: z.number().min(0),
    default_limit: z.number().int().positive(),
    recency_half_life_days: z.number().positive(),
    weights: z.object({
      semantic: z.number(),
      proximity: z.number(),
      recency: z.number(),
      frequency: z.number(),
      edge_confidence: z.number(),
    }),
    kind_priors: z.object({
      person: z.number().positive(),
      memory: z.number().positive(),
      plan: z.number().positive(),
    }),
  }),
});

export type FileConfig = z.infer<typeof fileSchema>;

export type Config = {
  serviceRoot: string;
  env: {
    databaseUrl: string;
    dwarBaseUrl: string;
    host: string;
    port: number;
    logLevel: z.infer<typeof envSchema>["LOG_LEVEL"];
  };
  embedding: FileConfig["embedding"];
  hnsw: FileConfig["hnsw"];
  page: FileConfig["page"];
  search: FileConfig["search"];
  dwar: FileConfig["dwar"];
  ingest: FileConfig["ingest"];
  recall: FileConfig["recall"];
};

function loadEnvFile(): void {
  try {
    process.loadEnvFile(join(serviceRoot, ".env"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw err;
    }
  }
}

export function loadFileConfig(): FileConfig {
  let raw: string;
  try {
    raw = readFileSync(tomlPath, "utf8");
  } catch {
    throw new Error(`missing config file: ${tomlPath}`);
  }
  const parsed = fileSchema.safeParse(parseToml(raw));
  if (!parsed.success) {
    throw new Error(`invalid config.toml: ${parsed.error.message}`);
  }
  if (parsed.data.page.default_size > parsed.data.page.max_size) {
    throw new Error("config.toml page.default_size must be <= page.max_size");
  }
  if (parsed.data.search.default_limit > parsed.data.search.max_limit) {
    throw new Error("config.toml search.default_limit must be <= search.max_limit");
  }
  return parsed.data;
}

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) {
    return cached;
  }
  loadEnvFile();
  const file = loadFileConfig();
  const envParsed = envSchema.safeParse(process.env);
  if (!envParsed.success) {
    const parts = envParsed.error.issues.map((issue) => {
      const loc = issue.path.join(".");
      return loc ? `${loc}: ${issue.message}` : issue.message;
    });
    throw new Error(`invalid environment: ${parts.join("; ")}`);
  }
  const env = envParsed.data;
  cached = {
    serviceRoot,
    env: {
      databaseUrl: env.DATABASE_URL,
      dwarBaseUrl: env.DWAR_BASE_URL.replace(/\/$/, ""),
      host: env.HOST,
      port: env.PORT,
      logLevel: env.LOG_LEVEL,
    },
    embedding: file.embedding,
    hnsw: file.hnsw,
    page: file.page,
    search: file.search,
    dwar: file.dwar,
    ingest: file.ingest,
    recall: file.recall,
  };
  return cached;
}
