# Yaad

Memory for dadi. People, memories, plans, places, and the edges between them. Yaad is a data API (not a tool API): every route exists for an agent calling through Hath. There is no auth; Yaad stays on the private mesh.

## Dependencies

- Postgres + pgvector (`DATABASE_URL`)
- Dwar at `http://dwar.dadi` for embeddings and ingest reasoning (every call sends `X-Dadi-Caller`: `yaad/ingest`, `yaad/recall`, `yaad/history`)
- Nas for mesh DNS, compose/prod networking, and the shared logging contract

## Layout

```
yaad/
  src/
    app.ts, config.ts, logging.ts, errors.ts, constants.ts
    db/           Drizzle client, schema, ANN, temporal reads
    dwar/         Dwar axios client
    ingest/       extract → validate → apply, RRULE materialization
    recall/       anchor → expand → score → gate
    routers/v1/   HTTP routes + schemas
    types/        domain types
  test/           Node test runner suites
  evals/          extraction eval cases from past mistakes + runner
  drizzle/        migrations
  prompts/        extraction prompt
  config.toml
```

## Config vs env

`config.toml` (checked in, baked into the image): recall weights, ingest thresholds (including `segment_limit` and `segment_candidate_limit`, the per-line candidate search), HNSW, Dwar timeout/retry, page and graph sizes, plan recurrence horizon. Every key is required; a missing one fails startup.

Topology is hardcoded in `src/constants.ts` (host, port, log level, `DWAR_BASE_URL`).

`DATABASE_URL` is required at startup (no empty default). Nas injects it in compose and on the appliance (`postgres://yaad:yaad@yaad-postgres:5432/yaad`). There is no Yaad `.env` — Postgres is not Preferences-editable; `.env.example` documents the variables. `TZ` is required too and must be an IANA zone: it is the box's time zone, which Nas writes to `/var/lib/dadi/timezone.env` from `/etc/localtime` on every boot and the container loads with `EnvironmentFile=`; compose requires it in the shell.

## Local run

```sh
cd ../nas
docker compose up yaad yaad-postgres
docker compose run --rm yaad npm run db:migrate
docker compose run --rm yaad npm test
```

Source is bind-mounted; edits restart in place. Start the full stack when Yaad needs Dwar.

Extraction evals run the current `prompts/extraction.md` through Dwar on cases taken from real ingests that went wrong, and write nothing. They need Dwar reachable at its mesh address and the box's `TZ`: `TZ=America/New_York npm run eval:extraction -- --runs=3`. Run them before shipping a prompt change, and add a case to `evals/extraction-cases.json` for every new kind of mistake an audit finds.

## CI / CD

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` → `ci` | PR + push to `main` | Postgres service, migrate, `npm test`, build images |
| `ci.yml` → `publish` | `main` after `ci` | Push `ghcr.io/<owner>/yaad:{latest,sha}` |

## Logging / error codes

Logs follow the nas JSON contract (`service=yaad`, request summary with `request_id` / `duration_ms`, errors with `code`). Default Fastify access logging is off.

HTTP errors: `{ "error": { "type": "<code>", "message": "..." } }`. Shared infra codes include `invalid_request`, `not_found`, `upstream_unreachable`, `internal_error`. Domain codes include `conflict`, `dwar`, `dimension_mismatch`, `extraction_failed`, `duplicate_node` (a create repeats a live node's normalized title and, for a plan, its time within an hour). See nas README for the full shared catalog.

## Node kinds

| kind | what it is | detail table |
| --- | --- | --- |
| `person` | someone Dadi knows | `person_detail` (birthday, aliases) |
| `memory` | a thing that happened | none |
| `plan` | an idea, reminder, or dated event | `plan_detail` (end_at, status, recurrence, series_id) |
| `place` | somewhere you go | `place_detail` (address, latitude, longitude) |

`occurred_at` is the single "when" for every kind. Unknown dates are `NULL`. `expires_at` is null for permanent nodes; observations get a timestamp from `ttl_days`.

## Places

A place is a real entity that recurs across events. Coordinates are optional. Yaad does not geocode. Convention: a plan links to its place with an `AT_LOCATION` edge (plan `src`, place `dst`).

## Recurrence

`plan_detail.recurrence` holds an RRULE on a **template** row. Yaad materializes instance rows out to `plan.recurrence_horizon_days`. Templates are excluded from date-bounded `POST /query` but remain visible to `recall`. Cap: `plan.max_instances_per_series`. Rules expand in the box's wall-clock time (the required `TZ`, which Nas writes from `/etc/localtime`), so a weekly 10:20 class stays at 10:20 across daylight-saving changes. An `update_node` that changes a template's `occurred_at`, `end_at`, or `recurrence` deletes its instances (history kept) and materializes them again from the new rule.

## Query vs recall

`recall` is the one read an agent needs: it anchors on a semantic `query`, explicit node ids, or the same exact filters `query` takes, then walks the graph. `query` is exact filters with offset paging and no graph walk — what the desktop widgets use for calendar windows.

## Corrections

Corrections go through `POST /ingest` as `update_node` / `close_node`, or by hand (source `manual`) through `POST /nodes`, `PATCH` / `DELETE /nodes/:id`, `POST /edges`, and `POST /edges/:id/close`. Each hand edit runs as one validated operation through ingest's apply path, so it writes history, re-embeds, anchors all-day plans, and rematerializes a series the same way; `POST /nodes` is rejected as `duplicate_node` like an ingest create. `PATCH` also takes `ttl_days` (memory and plan only) to set expiry from now, or null to clear it. Changed fields write `node_history`, attributed to whoever made the change (`source`, and `agent_id` for an agent), while the node keeps its creator's. Edges use `valid_from`/`valid_to`; to change one, close it and create its replacement.

## Orphans

A node left with no current edge by a delete, a `close_edge`, or a series rematerialization is deleted in the same transaction (with a `deleted` history row). Dated plans are kept: they stand on the timeline alone. `POST /ingest` and `DELETE /nodes/:id` return the swept ids as `orphans`. Nodes that were edgeless before the batch are not touched.

## Expiry

Observations may set `ttl_days`; expired nodes are filtered from recall/query/ingest candidates but not deleted. Only `memory` and `plan` may expire.

## Routes

| method | path | notes |
| --- | --- | --- |
| `GET` | `/health` | `{ "status": "ok" }` |
| `POST` | `/ingest` | extract and reconcile unstructured text |
| `POST` | `/recall` | graph retrieval anchored on a query, node ids, or filters |
| `POST` | `/query` | deterministic structured lookup |
| `GET` | `/nodes/:id` | node, detail, current edges |
| `POST` | `/nodes` | hand-made node: `{ kind, title, body?, occurred_at?, ttl_days?, detail? }`; 201 with the node |
| `PATCH` | `/nodes/:id` | hand edit: `{ title?, body?, occurred_at?, ttl_days?, detail? }`, at least one; returns the node |
| `DELETE` | `/nodes/:id` | delete plus orphan sweep; returns `{ id, orphans }` |
| `GET` | `/nodes/:id/history` | correction log |
| `POST` | `/history/search` | semantic search over `node_history` |
| `POST` | `/graph` | bounded live subgraph for the Memory network view |
| `POST` | `/edges` | hand-drawn edge: `{ src_id, dst_id, type (UPPER_SNAKE_CASE), properties?, confidence }`; 201 with the edge |
| `POST` | `/edges/:id/close` | close a current edge plus orphan sweep; returns `{ id, orphans }` |
| `GET` | `/lint` | read-only report of suspicious live nodes; see Lint |

Unknown request fields are a 422.

### `POST /graph`

Body: `{ seed_ids?, limit? }`. Without seeds: the `limit` most-accessed live nodes (default `graph.default_nodes`, cap `graph.max_nodes`). With seeds: the seeds plus their live one-hop neighbors, most-accessed first, up to `limit` total. `edges` are the current edges among the returned nodes. An unknown or expired seed is a 404.

### `POST /query`

Body: `{ kind?, name?, occurred_from?, occurred_to?, status?, limit?, offset? }`. At least one filter is required. Date bounds use interval overlap; undated rows are excluded when either bound is present.

## Ingest

`POST /ingest` takes `{ text, occurred_at, participant_ids?, source }`, plus `agent_id` (kebab-case, required) when `source` is `agent`; `source: "ingest"` takes no `agent_id`. Every node the batch creates records that `agent_id`, so an agent's writes can be traced and corrected. Pipeline: embed the text and each of its lines or sentences (up to `ingest.segment_limit`) → assemble candidates in code (nearest live nodes to the whole text and to each segment, every person named by title, alias, or first or last name as a whole word, pinned participants) → Dwar reasoning with `emit_operations`, its `occurred_at` rewritten in the box's local offset → when a create resembles a live node extraction was not shown (same normalized title, or a plan within 12 hours), extraction runs once more with those nodes added and a `recheck` note → validate the batch (structure, then extraction guards: every `close_node` quotes its `evidence` from the text, and no create duplicates a live node or another create, as `duplicate_node`) → apply in one transaction. Concurrent modification is 409.

Plans with `detail.all_day: true` have a date but no time of day: Yaad moves their `occurred_at` and `end_at` to local midnight of their dates (the box's `TZ`), so an all-day plan never carries an invented time. Absent `all_day` means a timed plan.

### Operations

| op | fields |
| --- | --- |
| `create_node` | `temp_id`, `kind`, `title`, `body?`, `occurred_at?`, `ttl_days?`, `detail?` |
| `update_node` | `node_id`, `title?`, `body?`, `occurred_at?`, `ttl_days?`, `detail?` |
| `close_node` | `node_id`, `reason`, `evidence` (the utterance words that retract it, quoted exactly) |
| `create_edge` | `src`, `dst`, `type`, `properties?`, `confidence` |
| `close_edge` | `edge_id`, `reason` |
| `noop` | `reason` |

The `emit_operations` tool schema has one `create_node` variant per kind: `memory` offers no `detail`, `plan` requires `detail.status`, and `person`/`place` offer only their own detail keys.

## Lint

`GET /lint` returns `{ findings: [{ rule, node_ids, title, note }] }` for live nodes that match what past audits found wrong: `status_snapshot` (as-of / not-yet wording on a memory that never expires), `working_note` (paths, branches, credentials, site quirks), `noon_placeholder` (a timed plan at exactly 12:00 local), `dated_hub` (a plan that owns dated items through `HAS_ITEM` yet carries a date of its own), `duplicate` (same kind and normalized title, plans in the same hour), and `unaliased_person` (a person whose first name is not an alias). It never changes the graph.

## Recall

`POST /recall` takes `{ query?, from?, hops?, kind?, name?, occurred_from?, occurred_to?, status?, limit?, debug? }` and needs a `query`, `from`, or a filter.

| anchors | when |
| --- | --- |
| the `from` node ids (404 if one is unknown or expired) | `from` is set; it cannot be combined with filters |
| filter matches, ranked by similarity to `query` and capped at `recall.anchor_limit` | filters and `query` |
| filter matches in `/query` order, capped at `limit` | filters without `query` |
| ANN hits above `recall.anchor_similarity_floor` | `query` only |

`hops` (0 to `recall.hop_cap`) walks exactly that deep. Omitted, the walk is gated (hop cap, marginal yield, token budget) when there is a `query` and skipped otherwise, so `{ from: [id], hops: 1 }` is a node with its neighbors. With a `query`, nodes rank by score and `coverage` / `sufficient` are set; without one, nodes order by hop then `occurred_at` and `score`, `coverage`, `sufficient` are null. `edges` are the current edges among the returned nodes. `debug: true` adds per-node score breakdown. Weights live in `[recall.weights]` in config.toml.
