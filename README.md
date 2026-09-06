# Yaad
Memory for Dadi. People, memories, plans, places, and the edges between them. A portal at `yaad.dadi` comes later.

Yaad is a data API, not a tool API. There is no auth. Yaad stays on the private mesh and is never published to a host interface.

Yaad's API exists for one consumer. Every route is one an agent calls through Dimaag. Anything that would only serve a UI, an operator, or a future service inside Yaad is not a route.

## Node kinds

| kind | what it is | detail table |
| --- | --- | --- |
| `person` | someone Dadi knows | `person_detail` (birthday, aliases) |
| `memory` | a thing that happened | none |
| `plan` | an idea, reminder, or dated event | `plan_detail` (end_at, status, recurrence, series_id) |
| `place` | somewhere you go | `place_detail` (address, latitude, longitude) |

`occurred_at` is the single "when" for every kind. A plan's start is `node.occurred_at`, not a second column. An undated idea has `status = 'idea'` and a null `occurred_at`. Unknown dates are `NULL`. `expires_at` is null for permanent nodes; observations get a timestamp computed from `ttl_days`.

## Places

A place is a real entity that recurs across events. Create one when an event happens somewhere nameable; reuse it rather than duplicating. Coordinates are optional — a place known only as "the coffee shop on Grand River" is valid. Yaad does not geocode; it stores what it is told.

Convention (not a schema constraint): a plan links to its place with an `AT_LOCATION` edge, plan as `src`, place as `dst`. Edge types stay free-text.

## Recurrence

`plan_detail.recurrence` holds an RRULE string on a **template** row (`series_id` null). Yaad materializes one ordinary plan row per occurrence out to `plan.recurrence_horizon_days` (default 365), each with `series_id` pointing at the template and `recurrence` null.

Templates are excluded from date-bounded `POST /query` — a pattern is not an event on a day. They remain fully visible to `recall`, which is how "what classes am I taking this semester" works without returning dozens of near-identical instance rows.

A hard cap `plan.max_instances_per_series` (default 500) fails the write loudly if a rule would expand past it.

**Editing a series is not implemented.** Changing a template's rule does not regenerate instances. Updating a single instance (`update_node`) changes that one occurrence — the common case ("class is in a different room Thursday").

## Query vs recall

`recall` is semantic. It answers "what do I know about X" via embeddings, graph walk, and scoring.

`query` is exact. It answers "what is on Tuesday" or "who is named Marcus" with filters on kind, name, date overlap, and plan status — no embeddings, no model call, no scoring.

They do not overlap and neither is a fallback for the other.

## Corrections

`node` is a plain current-state table. Corrections go through `POST /ingest` as `update_node` / `close_node` operations — the same path that validates extraction. Every changed field (`title`, `body`, `occurred_at`) writes a row to `node_history` recording the old and new value, embedded the same way nodes are, so a correction can be found later by meaning ("why did the color change") rather than by knowing which node or when. `close_node` removes the node and writes a `field: "deleted"` history row rather than leaving a dangling current-less row behind.

`GET /nodes/:id/history` returns a node's own correction log. `POST /history/search` does semantic search across every correction in the graph.

**Edges are different.** A relationship ending (a job, a plan) is a real state change worth keeping queryable as history, not a correction. Edges keep `valid_from`/`valid_to`; `close_edge` closes rather than deletes. There is no `as_of` anywhere in the API — point-in-time graph reconstruction was removed as unused complexity.

## Expiry

Most memories are permanent. Observations are not — what someone wore, how
they seemed, what traffic was like. Extraction sets `ttl_days` on those, and
Yaad computes `expires_at` from the memory's own timestamp.

Expired nodes are filtered out of recall, query, and ingest candidate
assembly. They are not deleted — the row stays, `GET /nodes/:id` still
returns it, and nothing sweeps the table. Deletion is irreversible and the
model's TTL judgment is unproven; filtering is reversible and enough.

Only `memory` and `plan` nodes may expire. A `person` or `place` with
`ttl_days` is a 422. Entities persist; observations about them expire.

Corrections and expiry are different mechanisms and do not overlap. "My
favorite color is not green" is a correction — `update_node` rewrites the
text and `node_history` records it. Nothing expires; the fact changed.

## Routes

| method | path | notes |
| --- | --- | --- |
| `GET` | `/health` | unversioned, `{ "status": "ok" }` |
| `POST` | `/ingest` | extract and reconcile unstructured text |
| `POST` | `/recall` | ranked multi-hop retrieval |
| `POST` | `/query` | deterministic structured lookup |
| `GET` | `/nodes/:id` | node, detail, current edges |
| `GET` | `/nodes/:id/history` | correction log for a node (survives delete) |
| `POST` | `/history/search` | semantic search over `node_history` |

Unknown request fields are a 422.

### `POST /query`

Body: `{ kind?, name?, occurred_from?, occurred_to?, status?, limit?, offset? }`. At least one filter is required. `name` is case-insensitive exact match on `title`, or membership in `person_detail.aliases` when kind is `person` or unset. Date bounds use interval overlap (a trip spanning the 3rd–8th appears when asking about the 5th); undated rows are excluded when either bound is present. `status` implies `kind = plan`; a conflicting `kind` is 422. Limit defaults to `page.default_size`, capped at `page.max_size`.

## Ingest

`POST /ingest` takes `{ text, occurred_at, participant_ids?, source }`. `occurred_at` is required and is the utterance time. Relative dates in the text resolve against it, not against the clock.

The pipeline is:

1. Embed `text`.
2. Assemble candidates in code: ANN hits above `ingest.candidate_similarity_floor`, people whose title or alias appears in the text, `participant_ids`, and current edges attached to those nodes. The model does not query.
3. Call Dwar `POST /chat/reasoning` with `prompts/extraction.md` as the system prompt and a single tool, `emit_operations`. `stop_reason` must be `tool_use`. Prose is a hard failure.
4. Validate the whole batch. Any bad id, duplicate `temp_id`, kind/detail mismatch, illegal plan status, or self-edge rejects the batch. No writes.
5. Apply in one transaction through update/delete. Embed creates, title/body updates, and per-field history texts before the transaction. Concurrent modification of a referenced row aborts with 409. Recurring plans expand into instance rows in the same transaction.

### Operations

| op | fields |
| --- | --- |
| `create_node` | `temp_id`, `kind`, `title`, `body?`, `occurred_at?`, `ttl_days?`, `detail?` |
| `update_node` | `node_id`, `title?`, `body?`, `occurred_at?`, `ttl_days?`, `detail?` |
| `close_node` | `node_id`, `reason` (hard-deletes; logs history) |
| `create_edge` | `src`, `dst` (node id or `temp_id`), `type`, `properties?`, `confidence` |
| `close_edge` | `edge_id`, `reason` |
| `noop` | `reason` |

`temp_id` exists only inside one batch so a create and an edge can land together. Plan promotion is `update_node` on `detail.status`. `noop` is a normal outcome when the text is not worth storing.

The response repeats the operations with resolved ids and a count by type.

## Recall

`POST /recall` takes `{ query, limit?, debug? }`. Retrieval never calls a model except to embed the query. Every gate is a number in `config.toml`.

1. **Anchor.** ANN over nodes. Keep hits above `recall.anchor_similarity_floor`, capped at `anchor_limit`. If none clear the floor, return an empty set with coverage 0. The floor is not widened.
2. **Expand.** BFS, one hop at a time, both directions, up to `hop_cap`. First visit is the hop distance. Same hop keeps the higher product of edge confidences.
3. **Score.** Weighted sum of the components below, then multiplied by the kind prior.
4. **Gate.** After each hop, stop when newly discovered nodes scoring at or above `relevance_threshold` fall below `marginal_yield_minimum`, or the hop cap is hit, or the estimated token budget is exhausted (title+body chars / 4 of nodes above the relevance threshold).
5. **Return.** Top `limit` nodes with detail and the path edges back toward the anchors.

**Coverage** is the mean of the top `coverage_top_n` returned scores, 0 when nothing is returned. **`sufficient`** is `coverage >= coverage_floor`. Low coverage is explicit.

`debug: true` adds a `scores` object on every returned node. Use that to tune weights.

Returned nodes get `access_count + 1` and `last_accessed_at` in a follow-up update that does not delay the response.

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

`config.toml` is checked in — recall weights, ingest thresholds, HNSW parameters, Dwar timeout and retry.

Topology is hardcoded in `src/constants.ts`. Dwar is at `http://dwar.dadi`, resolved by Nas's reverse proxy in both dev and prod. There is no `.env` file.

`DATABASE_URL` and `LOG_LEVEL` come from the orchestrator — the compose file in dev, the quadlet in prod.

## Development

Yaad runs as part of the dadiOS stack. Bring it up through Nas:

```sh
cd ../nas
docker compose up yaad yaad-postgres
docker compose run --rm yaad npm run db:migrate
```

Source is bind-mounted, so edits here restart the service in place. Start the rest of the stack (`docker compose up`) when Yaad needs Dwar.

Tests run the same way:

```sh
docker compose run --rm yaad npm test
```
