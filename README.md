# Yaad

Memory for dadi. People, memories, plans, places, and the edges between them. Yaad is a data API (not a tool API): every route exists for an agent calling through Dimaag. There is no auth; Yaad stays on the private mesh.

## Dependencies

- Postgres + pgvector (`DATABASE_URL`)
- Dwar at `http://dwar.dadi` for embeddings and ingest reasoning
- Nas for mesh DNS, compose/prod networking, and the shared logging contract

## Layout

```
yaad/
  src/
    app.ts, config.ts, logging.ts, errors.ts, constants.ts
    db/           Drizzle client, schema, ANN, temporal reads
    dwar/         Dwar axios client
    ingest/       extract → validate → apply
    recall/       anchor → expand → score → gate
    plans/        RRULE materialization
    routers/v1/   HTTP routes + schemas
    types/        domain types
  test/           Node test runner suites
  drizzle/        migrations
  prompts/        extraction prompt
  config.toml
```

## Config vs env

`config.toml` (checked in): recall weights, ingest thresholds, HNSW, Dwar timeout/retry, page sizes.

Topology is hardcoded in `src/constants.ts` (host, port, log level, `DWAR_BASE_URL`).

`DATABASE_URL` is required at startup (no empty default). Nas injects it in compose and on the appliance (`postgres://yaad:yaad@yaad-postgres:5432/yaad`). There is no Yaad `.env` — Postgres is not Preferences-editable.

## Local run

```sh
cd ../nas
docker compose up yaad yaad-postgres
docker compose run --rm yaad npm run db:migrate
docker compose run --rm yaad npm test
```

Source is bind-mounted; edits restart in place. Start the full stack when Yaad needs Dwar.

## CI / CD

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` → `ci` | PR + push to `main` | Postgres service, migrate, `npm test`, build images |
| `ci.yml` → `publish` | `main` after `ci` | Push `ghcr.io/<owner>/yaad:{latest,sha}` |

## Logging / error codes

Logs follow the nas JSON contract (`service=yaad`, request summary with `request_id` / `duration_ms`, errors with `code`). Default Fastify access logging is off.

HTTP errors: `{ "error": { "type": "<code>", "message": "..." } }`. Shared infra codes include `invalid_request`, `not_found`, `upstream_unreachable`, `internal_error`. Domain codes include `conflict`, `dwar`, `dimension_mismatch`, `extraction_failed`. See nas README for the full shared catalog.

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

`plan_detail.recurrence` holds an RRULE on a **template** row. Yaad materializes instance rows out to `plan.recurrence_horizon_days`. Templates are excluded from date-bounded `POST /query` but remain visible to `recall`. Cap: `plan.max_instances_per_series`. Editing a series rule does not regenerate instances.

## Query vs recall

`recall` is semantic (embeddings, graph walk, scoring). `query` is exact filters — no embeddings. They do not overlap and neither is a fallback for the other.

## Corrections

Corrections go through `POST /ingest` as `update_node` / `close_node`. Changed fields write `node_history`. Edges use `valid_from`/`valid_to` and `close_edge`.

## Expiry

Observations may set `ttl_days`; expired nodes are filtered from recall/query/ingest candidates but not deleted. Only `memory` and `plan` may expire.

## Routes

| method | path | notes |
| --- | --- | --- |
| `GET` | `/health` | `{ "status": "ok" }` |
| `POST` | `/ingest` | extract and reconcile unstructured text |
| `POST` | `/recall` | ranked multi-hop retrieval |
| `POST` | `/query` | deterministic structured lookup |
| `GET` | `/nodes/:id` | node, detail, current edges |
| `GET` | `/nodes/:id/history` | correction log |
| `POST` | `/history/search` | semantic search over `node_history` |

Unknown request fields are a 422.

### `POST /query`

Body: `{ kind?, name?, occurred_from?, occurred_to?, status?, limit?, offset? }`. At least one filter is required. Date bounds use interval overlap; undated rows are excluded when either bound is present.

## Ingest

`POST /ingest` takes `{ text, occurred_at, participant_ids?, source }`. Pipeline: embed → assemble candidates in code → Dwar reasoning with `emit_operations` → validate batch → apply in one transaction. Concurrent modification is 409.

### Operations

| op | fields |
| --- | --- |
| `create_node` | `temp_id`, `kind`, `title`, `body?`, `occurred_at?`, `ttl_days?`, `detail?` |
| `update_node` | `node_id`, `title?`, `body?`, `occurred_at?`, `ttl_days?`, `detail?` |
| `close_node` | `node_id`, `reason` |
| `create_edge` | `src`, `dst`, `type`, `properties?`, `confidence` |
| `close_edge` | `edge_id`, `reason` |
| `noop` | `reason` |

## Recall

`POST /recall` takes `{ query, limit?, debug? }`. Anchor ANN → BFS expand → score → gate. Coverage and `sufficient` are explicit. `debug: true` adds per-node score breakdown. Weights live in `[recall.weights]` in config.toml.
