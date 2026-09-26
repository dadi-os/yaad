/** Typed process config. The only module that reads the environment or config.toml. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { DWAR_BASE_URL, HOST, LOG_LEVEL, PORT } from "./constants.js";

const serviceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tomlPath = join(serviceRoot, "config.toml");

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
  graph: z.object({
    default_nodes: z.number().int().positive(),
    max_nodes: z.number().int().positive(),
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
  plan: z.object({
    recurrence_horizon_days: z.number().int().positive(),
    max_instances_per_series: z.number().int().positive(),
    timezone: z.string().min(1),
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
      place: z.number().positive(),
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
    logLevel: typeof LOG_LEVEL;
  };
  embedding: FileConfig["embedding"];
  hnsw: FileConfig["hnsw"];
  page: FileConfig["page"];
  graph: FileConfig["graph"];
  search: FileConfig["search"];
  dwar: FileConfig["dwar"];
  ingest: FileConfig["ingest"];
  plan: FileConfig["plan"];
  recall: FileConfig["recall"];
};

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
  if (parsed.data.graph.default_nodes > parsed.data.graph.max_nodes) {
    throw new Error("config.toml graph.default_nodes must be <= graph.max_nodes");
  }
  if (parsed.data.search.default_limit > parsed.data.search.max_limit) {
    throw new Error("config.toml search.default_limit must be <= search.max_limit");
  }
  if (!Intl.supportedValuesOf("timeZone").includes(parsed.data.plan.timezone)) {
    throw new Error(`config.toml plan.timezone is not an IANA time zone: ${parsed.data.plan.timezone}`);
  }
  return parsed.data;
}

let cached: Config | undefined;

/** Clear the memoized config (tests only). */
export function resetConfigCache(): void {
  cached = undefined;
}

/**
 * Load process config from config.toml and required env.
 * @throws When config.toml is invalid or DATABASE_URL is missing.
 */
export function loadConfig(): Config {
  if (cached) {
    return cached;
  }
  const file = loadFileConfig();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  cached = {
    serviceRoot,
    env: {
      databaseUrl,
      dwarBaseUrl: DWAR_BASE_URL,
      host: HOST,
      port: PORT,
      logLevel: LOG_LEVEL,
    },
    embedding: file.embedding,
    hnsw: file.hnsw,
    page: file.page,
    graph: file.graph,
    search: file.search,
    dwar: file.dwar,
    ingest: file.ingest,
    plan: file.plan,
    recall: file.recall,
  };
  return cached;
}
