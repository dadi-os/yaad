# Yaad
Memory for Dadi. People, memories, plans, and the edges between them. A portal at `yaad.dadi` comes later.

Yaad is a data API, not a tool API. There is no auth. Yaad stays on the private mesh and is never published to a host interface.

## Node kinds

| kind | what it is | detail table |
| --- | --- | --- |
| `person` | someone Dadi knows | `person_detail` (birthday, aliases) |
| `memory` | a thing that happened | none |
| `plan` | an idea, reminder, or dated event | `plan_detail` (end_at, status, recurrence) |

`occurred_at` is the single "when" for every kind. A plan's start is `node.occurred_at`, not a second column. An undated idea has `status = 'idea'` and a null `occurred_at`.

## Corrections

`node` is a plain current-state table — `PATCH` updates it in place. Every changed field (`title`, `body`, `occurred_at`) writes a row to `node_history` recording the old and new value, embedded the same way nodes are, so a correction can be found later by meaning ("why did the color change") rather than by knowing which node or when. `DELETE` removes the node and writes a `field: "deleted"` history row rather than leaving a dangling current-less row behind.

`GET /v1/nodes/:id/history` returns a node's own correction log. `POST /v1/history/search` does semantic search across every correction in the graph.

**Edges are different.** A relationship ending (a job, a plan) is a real state change worth keeping queryable as history, not a correction. Edges keep `valid_from`/`valid_to`; `DELETE /v1/edges/:id` still closes rather than deletes. There is no `as_of` anywhere in the API — point-in-time graph reconstruction was removed as unused complexity.

## Routes

| method | path | notes |
| --- | --- | --- |
| `GET` | `/health` | unversioned, `{ "status": "ok" }` |
| `POST` | `/v1/nodes` | create, with detail payload by kind |
| `GET` | `/v1/nodes/:id` | node, detail, current edges |
| `GET` | `/v1/nodes/:id/history` | correction log for a node (survives delete) |
| `PATCH` | `/v1/nodes/:id` | update in place; writes `node_history` |
| `DELETE` | `/v1/nodes/:id` | hard-delete; logs `deleted` history; closes open edges |
| `POST` | `/v1/edges` | create |
| `DELETE` | `/v1/edges/:id` | close |
| `GET` | `/v1/timeline` | `?from&to&status&limit&offset` |
| `GET` | `/v1/people/:id` | person, detail, current edges grouped by type |
| `POST` | `/v1/search` | embed the query, top-k cosine distance |
| `POST` | `/v1/history/search` | semantic search over `node_history` |
| `POST` | `/v1/ingest` | extract and reconcile unstructured text |
| `POST` | `/v1/recall` | ranked multi-hop retrieval |
| `POST` | `/v1/admin/backfill-embeddings` | fill nodes with a null embedding |

Unknown request fields are a 422. `/v1/search` is a dumb ANN lookup so embeddings can be checked. It is not recall.

Timeline queries `plan` nodes joined to `plan_detail`, ordered by `occurred_at`. Range filters (`from` / `to`) drop undated ideas. A `status`-only query includes them.

## Ingest

`POST /v1/ingest` takes `{ text, occurred_at, participant_ids?, source }`. `occurred_at` is required and is the utterance time. Relative dates in the text resolve against it, not against the clock.

The pipeline is:

1. Embed `text`.
2. Assemble candidates in code: ANN hits above `ingest.candidate_similarity_floor`, people whose title or alias appears in the text, `participant_ids`, and current edges attached to those nodes. The model does not query.
3. Call Dwar `POST /v1/chat/reasoning` with `prompts/extraction.md` as the system prompt and a single tool, `emit_operations`. `stop_reason` must be `tool_use`. Prose is a hard failure.
4. Validate the whole batch. Any bad id, duplicate `temp_id`, kind/detail mismatch, illegal plan status, or self-edge rejects the batch. No writes.
5. Apply in one transaction through update/delete. Embed creates, title/body updates, and per-field history texts before the transaction. Concurrent modification of a referenced row aborts with 409.

### Operations

| op | fields |
| --- | --- |
| `create_node` | `temp_id`, `kind`, `title`, `body?`, `occurred_at?`, `detail?` |
| `update_node` | `node_id`, `title?`, `body?`, `occurred_at?`, `detail?` |
| `close_node` | `node_id`, `reason` (hard-deletes; logs history) |
| `create_edge` | `src`, `dst` (node id or `temp_id`), `type`, `properties?`, `confidence` |
| `close_edge` | `edge_id`, `reason` |
| `noop` | `reason` |

`temp_id` exists only inside one batch so a create and an edge can land together. Plan promotion is `update_node` on `detail.status`. `noop` is a normal outcome when the text is not worth storing.

The response repeats the operations with resolved ids and a count by type.

## Recall

`POST /v1/recall` takes `{ query, limit?, debug? }`. Retrieval never calls a model except to embed the query. Every gate is a number in `config.toml`.

1. **Anchor.** ANN over nodes. Keep hits above `recall.anchor_similarity_floor`, capped at `anchor_limit`. If none clear the floor, return an empty set with coverage 0. The floor is not widened.
2. **Expand.** BFS, one hop at a time, both directions, up to `hop_cap`. First visit is the hop distance. Same hop keeps the higher product of edge confidences.
3. **Score.** Weighted sum of the components below, then multiplied by the kind prior.
4. **Gate.** After each hop, stop when newly discovered nodes scoring at or above `relevance_threshold` fall below `marginal_yield_minimum`, or the hop cap is hit, or the estimated token budget is exhausted (title+body chars / 4 of nodes above the relevance threshold).
5. **Return.** Top `limit` nodes with detail and the path edges back toward the anchors.

**Coverage** is the mean of the top `coverage_top_n` returned scores, 0 when nothing is returned. **`sufficient`** is `coverage >= coverage_floor`. Low coverage is explicit.

`debug: true` adds a `scores` object on every returned node. Use that to tune weights.

Returned nodes get `access_count + 1` and `last_accessed_at` in a follow-up update that does not delay the response. There is no salience job in this pass.

### Scoring components

| component | what it is |
| --- | --- |
| semantic | cosine similarity of the node embedding and the query embedding |
| proximity | `1 / (1 + hop)` from the nearest anchor |
| recency | `exp(-ln(2) * age_days / recency_half_life_days)` on `occurred_at`, or `created_at` if `occurred_at` is null |
| frequency | `log(1 + access_count) / log(1 + max access_count in the candidate set)` |
| edge_confidence | product of `confidence` along the BFS path; anchors are 1 |
| kind prior | per-kind multiplier from `recall.kind_priors` |

Weights live in `[recall.weights]`. They do not need to sum to 1. Raise semantic to trust ANN more. Raise proximity to prefer nearby graph nodes. Raise a kind prior above 1.0 to boost that kind at the same hop and similarity. All of these will be wrong on real data; change the toml, not the code.

## Config vs env

`config.toml` is checked in. It holds embedding dimension, embed batch size, HNSW `ef_search`, page sizes, search limit, Dwar timeout/retry, ingest candidate caps, and recall hop/score/coverage knobs. Change those in review.

`.env` is environment and deployment only:

```
DATABASE_URL
DWAR_BASE_URL
HOST
PORT
LOG_LEVEL
```

Copy `.env.example` to `.env`. The process will not start if any of those are missing or if `config.toml` is malformed. Dimension mismatches from Dwar fail the write. A Dwar outage fails the write. The normal write path never stores a null embedding.

## Run locally

Postgres from compose, Yaad on the host (so you can curl it). Compose does not publish Yaad's port. That is intentional.

```sh
cp .env.example .env
docker compose up -d postgres
npm install
npx drizzle-kit generate   # only when the schema changes
npm run build
npm test
npm start
```

`GET http://127.0.0.1:8090/health` should return `{"status":"ok"}`. Point `DWAR_BASE_URL` at a running Dwar. Node create, patch (title/body), search, and backfill all call `POST /v1/embed`.

To run Yaad inside compose as well:

```sh
docker compose up --build
```

Yaad then listens on `8080` on the compose network only. Reach it from another service on that network, or with `docker compose exec yaad`. There is no host port mapping.
