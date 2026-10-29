# Yaad

Memory for dadi. People, memories, plans, places, and the edges between them. Yaad is a data API (not a tool API): every route exists for an agent calling through Hath. There is no auth; Yaad stays on the private mesh.

## Dependencies

- Postgres + pgvector (`DATABASE_URL`)
- Dwar at `http://dwar.dadi` for embeddings and ingest extraction on its work lane (every call sends `X-Dadi-Caller`: `yaad/ingest`, `yaad/recall`, `yaad/history`)
- Nas for mesh DNS, compose/prod networking, and the shared logging contract

## Layout

```
yaad/
  src/
    app.ts, config.ts, logging.ts, errors.ts, constants.ts
    db/           Drizzle client, schema, ANN, temporal reads
    dwar/         Dwar axios client
    ingest/       extract → validate → apply, RRULE validation and expansion
    recall/       anchor → expand → score → gate
    routers/v1/   HTTP routes + schemas; `GET /events` streams `changed` after every write so Thaali refetches instead of polling
    types/        domain types
  test/           Node test runner suites
  evals/          extraction eval cases from past mistakes + runner
  drizzle/        migrations
  prompts/        extraction prompt
  config.toml
```

## Config vs env

`config.toml` (checked in, baked into the image): recall weights, ingest thresholds (including `segment_limit` and `segment_candidate_limit`, the per-line candidate search), HNSW, Dwar timeout/retry, page sizes, plan recurrence horizon. Every key is required; a missing one fails startup.

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

HTTP errors: `{ "error": { "type": "<code>", "message": "..." } }`. Shared infra codes include `invalid_request`, `not_found`, `upstream_unreachable`, `internal_error`. Domain codes include `conflict`, `dwar`, `dimension_mismatch`, `extraction_failed`, `duplicate_node` (a create repeats a live node's normalized title and, for a plan, its time within an hour), `unlinked_node` (extraction created a node no edge in the batch touches). See nas README for the full shared catalog.

## Node kinds

| kind | what it is | detail table |
| --- | --- | --- |
| `person` | someone Dadi knows | `person_detail` (birthday, aliases) |
| `memory` | a thing that happened | none |
| `plan` | an idea, reminder, deadline, or dated event; everything time-bound | `plan_detail` (end_at, all_day, status, recurrence, kind, due_at, opens_at, time_zone, hide_from_planner) |
| `place` | somewhere you go | `place_detail` (address, latitude, longitude) |

`occurred_at` is the single "when" for every kind, except that a plan's deadline is `plan_detail.due_at`: a deadline-only plan (homework) has `occurred_at` NULL and `due_at` set, and a scheduled task has both. Unknown dates are `NULL`. `expires_at` is null for permanent nodes; observations get a timestamp from `ttl_days`.

## Places

A place is a real entity that recurs across events. Coordinates are optional. Yaad does not geocode. Convention: a plan links to its place with an `AT_LOCATION` edge (plan `src`, place `dst`); the place is a building whose `place_detail.address` is a full street address (clients open directions from it), and the room goes on the edge (`{"room": "1345"}`).

## Recurrence

`plan_detail.recurrence` holds a rule on the plan itself: a bare RRULE (`FREQ=WEEKLY;BYDAY=FR;UNTIL=…`) or `RRULE:` and `EXDATE:` lines for skipped days. The plan's `occurred_at` / `end_at` are its first occurrence; a plan with no start (rent due on the 1st) anchors its series on `due_at`, and every time of the plan (end, due, opens) moves with each occurrence. A recurring plan is stored once and validated on write (it needs `occurred_at`, and the rule must parse); its occurrences are never stored. A date-bounded `POST /query` works them out on read and merges them, in time order, with dated nodes before paging: each occurrence carries the plan's id, its own `occurred_at` / `end_at` / `due_at` / `opens_at`, and `detail.series_id` = the plan's id (null on everything else). A date range also matches a plan whose `due_at` falls in it. An open-ended range reaches `plan.recurrence_horizon_days` past its start; a range holding more than `plan.max_instances_per_series` occurrences of one plan is `invalid_request`. `recall` sees the plan once. Rules expand in the box's wall-clock time (the required `TZ`, which Nas writes from `/etc/localtime`), so a weekly 10:20 class stays at 10:20 across daylight-saving changes; `UNTIL` and `EXDATE` are local times. Changing the rule, start, or duration changes the next query's occurrences.

## Query vs recall

`recall` is the one read an agent needs: it anchors on a semantic `query`, explicit node ids, or the same exact filters `query` takes, then walks the graph. `query` is exact filters with offset paging and no graph walk — what the desktop widgets use for calendar windows.

## Corrections

Corrections go through `POST /ingest` as `update_node` / `close_node`, or by hand (source `manual`) through `POST /nodes`, `PATCH` / `DELETE /nodes/:id`, `POST /edges`, and `POST /edges/:id/close`. Each hand edit runs as one validated operation through ingest's apply path, so it writes history, re-embeds, anchors all-day plans, and validates a recurring rule the same way; `POST /nodes` is rejected as `duplicate_node` like an ingest create. `PATCH` also takes `ttl_days` (memory and plan only) to set expiry from now, or null to clear it. Changed fields write `node_history`, attributed to whoever made the change (`source`, and `agent_id` for an agent), while the node keeps its creator's. Edges use `valid_from`/`valid_to`; to change one, close it and create its replacement.

## Orphans

A node left with no current edge by a delete or a `close_edge` is deleted in the same transaction (with a `deleted` history row). Dated plans are kept: they stand on the timeline alone. `POST /ingest` and `DELETE /nodes/:id` return the swept ids as `orphans`. Nodes that were edgeless before the batch are not touched.

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
| `POST` | `/graph` | live subgraph for the Memory network view |
| `POST` | `/edges` | hand-drawn edge: `{ src_id, dst_id, type (UPPER_SNAKE_CASE), properties?, confidence }`; 201 with the edge |
| `POST` | `/edges/:id/close` | close a current edge plus orphan sweep; returns `{ id, orphans }` |
| `GET` | `/lint` | read-only report of suspicious live nodes; see Lint |
| `POST` | `/timeline` | sessions in `{ from, to }` through one `view` (`planner`, `due`, `month`, `someday`, `tile`); returns `{ items }`; see Timeline |
| `PUT` | `/timeline/outcome` | Ankur's Completed toggle: `{ plan_id, occurrence_date, outcome: "done" \| null }`, source `manual`; returns `{ plan_id, occurrence_date, outcome, outcome_at }` |

Unknown request fields are a 422.

## Timeline

There is no separate planner: everything time-bound is a plan, agents write plans only through `POST /ingest`, and every client view is a filter over the same plans, session by session. A session is one occurrence of a series or a one-off plan's only one, named by the plan id and its `occurrence_date` (the local date it was first scheduled for: its start's date, else its due's). Plan fields the views compute over: `kind` (commitments `class`, `lab`, `exam`, `task`, `meeting`, `appointment`, `reservation`, `social`, `trip`, `bill`; routines `meal`, `shower`, `gym`, `study`, `focus`), `due_at`, `opens_at`, `time_zone` (the place's IANA zone when it is not the box's), and `hide_from_planner` (in the timeline but never on the grid: office hours he will not attend). Everything else about a plan is a memory on an edge: a session's notes are `HAS_NOTE {"occurrence": "YYYY-MM-DD"}` memories, and a study block links `FOR` the exam or task it prepares.

`plan_occurrence` holds what happened to one session, as a row only while it differs: `state` (`scheduled`, `moved` with its `start_at` / `end_at`, `cancelled`), `outcome` (`done`, `missed`, or null for not marked), `outcome_at`, `actual_start` / `actual_end`, and the `source` that wrote it (an agent id, `manual`, or `ingest`). Agents write it with the `edit_occurrence` ingest op; Ankur's only hand write is `PUT /timeline/outcome` (done or null). `missed` comes only from agents.

`POST /timeline` views (ideas reach only `someday`):

| view | items |
| --- | --- |
| `planner` | timed (not all-day) sessions with a start and an end overlapping the range, not hidden; moved times applied, cancelled sessions kept with `state: "cancelled"` |
| `due` | sessions whose `due_at` falls in the range |
| `month` | due sessions, all-day and multi-day sessions, and one-off timed sessions of a commitment kind (series and routines left out); not hidden |
| `someday` | every idea, and tasks with a due or an open but no start, not a bill, not a series, not completed, and not due before `from` |
| `tile` | sessions and dues of a commitment kind (or no kind), not hidden: the home ribbon |

Each item: `id`, `occurrence_date` (null for an undated idea), `title`, `body`, `kind`, `status`, `start_at` / `end_at` (moves applied), `due_at`, `opens_at`, `all_day`, `time_zone`, `hide_from_planner`, `state`, `outcome`, `outcome_at`, `actual_start` / `actual_end`, `recurrence` (the rule in words, or null), `series` (`{ completed, total }` held so far, cancelled left out, reaching back at most `plan.recurrence_horizon_days`), `place` (`{ id, title, address, room }`), `owner` (the plan's agent id, else its source), and that session's `notes`.

Routine plans (meal, shower, gym, study, focus) never anchor a semantic recall and are left out of `POST /graph`; ingest still sees them as candidates so agents can edit their sessions.

### `POST /graph`

Body: `{ seed_ids? }`. Without seeds: every live node. With seeds: the seeds plus all their live one-hop neighbors. `edges` are the current edges among the returned nodes. An unknown or expired seed is a 404.

### `POST /query`

Body: `{ kind?, name?, occurred_from?, occurred_to?, status?, limit?, offset? }`. At least one filter is required. Date bounds use interval overlap; undated rows are excluded when either bound is present.

## Ingest

`POST /ingest` takes `{ text, occurred_at, participant_ids?, source }`, plus `agent_id` (kebab-case, required) when `source` is `agent`; `source: "ingest"` takes no `agent_id`. Every node the batch creates records that `agent_id`, so an agent's writes can be traced and corrected. Pipeline: embed the text and each of its lines or sentences (up to `ingest.segment_limit`) → assemble candidates in code (nearest live nodes to the whole text and to each segment, every person named by title, alias, or first or last name as a whole word, pinned participants) → Dwar work lane with `emit_operations`, its `occurred_at` rewritten in the box's local offset → when a create resembles a live node extraction was not shown (same normalized title, or a plan within 12 hours), or a create has no edge in the batch, extraction runs once more with those nodes added and a `recheck` note saying which → validate the batch (structure, then extraction guards: every `close_node` quotes its `evidence` from the text, no create duplicates a live node or another create, as `duplicate_node`, and every created node has an edge, as `unlinked_node`) → apply in one transaction. Concurrent modification is 409.

Plans with `detail.all_day: true` have a date but no time of day: Yaad moves their `occurred_at`, `end_at` and `due_at` to local midnight of their dates (the box's `TZ`), so an all-day plan never carries an invented time. Absent `all_day` means a timed plan.

### Operations

| op | fields |
| --- | --- |
| `create_node` | `temp_id`, `kind`, `title`, `body?`, `occurred_at?`, `ttl_days?`, `detail?` |
| `update_node` | `node_id`, `title?`, `body?`, `occurred_at?`, `ttl_days?`, `detail?` |
| `close_node` | `node_id`, `reason`, `evidence` (the utterance words that retract it, quoted exactly) |
| `create_edge` | `src`, `dst`, `type`, `properties?`, `confidence` |
| `close_edge` | `edge_id`, `reason` |
| `edit_occurrence` | `node_id`, `occurrence_date`, `state?`, `start_at?` / `end_at?` (with `state: "moved"`; a move without `end_at` keeps the session's length), `outcome?`, `actual_start?`, `actual_end?`; applied after the batch's node updates, 422 when the plan has no session that day |
| `noop` | `reason` |

The `emit_operations` tool schema has one `create_node` variant per kind: `memory` offers no `detail`, `plan` requires `detail.status`, and `person`/`place` offer only their own detail keys.

## Lint

`GET /lint` returns `{ findings: [{ rule, node_ids, title, note }] }` for live nodes that match what past audits found wrong: `status_snapshot` (as-of / not-yet wording on a memory that never expires), `working_note` (paths, branches, wakes, credentials, file names and line numbers, and lessons about how a site or tool behaves), `agent_instruction` (a rule for how agents work, which belongs in a charter), `noon_placeholder` (a timed plan at exactly 12:00 local), `dated_hub` (a plan that owns dated items through `HAS_ITEM` yet carries a date of its own), `long_span` (a one-off plan spanning more than a week, usually a period that is a rule), `duplicate_series` (two recurring plans with the same rule and first meeting, so each meeting shows twice), `duplicate` (any kind with the same normalized title, plans in the same hour), `unaliased_person` (a person whose first name is not an alias), `place_without_address` (a place plans are `AT_LOCATION` whose address is missing or has no building number and street), and `floating` (a node with no current edge, which recall reaches only by similarity). It never changes the graph.

## Recall

`POST /recall` takes `{ query?, from?, hops?, kind?, name?, occurred_from?, occurred_to?, status?, limit?, debug? }` and needs a `query`, `from`, or a filter.

| anchors | when |
| --- | --- |
| the `from` node ids (404 if one is unknown or expired) | `from` is set; it cannot be combined with filters |
| filter matches, ranked by similarity to `query` and capped at `recall.anchor_limit` | filters and `query` |
| filter matches in `/query` order, capped at `limit` | filters without `query` |
| ANN hits above `recall.anchor_similarity_floor` | `query` only |

`hops` (0 to `recall.hop_cap`) walks exactly that deep. Omitted, the walk is gated (hop cap, marginal yield, token budget) when there is a `query` and skipped otherwise, so `{ from: [id], hops: 1 }` is a node with its neighbors. With a `query`, nodes rank by score and `coverage` / `sufficient` are set; without one, nodes order by hop then `occurred_at` and `score`, `coverage`, `sufficient` are null. `edges` are the current edges among the returned nodes. `debug: true` adds per-node score breakdown. Weights live in `[recall.weights]` in config.toml.
