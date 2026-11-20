# Yaad

Memory for dadi. People, memories, plans, places, and the edges between them. Yaad is a data API (not a tool API): every route exists for an agent calling through Hath. There is no auth; Yaad stays on the private mesh.

## Dependencies

- Postgres + pgvector (`DATABASE_URL`)
- Dwar at `http://dwar.dadi` for embeddings and ingest extraction on `/chat/complete` (every call sends `X-Dadi-Caller`: `yaad/ingest`, `yaad/recall`, `yaad/history`)
- Nas for mesh DNS, compose/prod networking, and the shared logging contract

## Layout

```
yaad/
  src/
    app.ts, config.ts, logging.ts, errors.ts, constants.ts
    db/           Drizzle client, schema, ANN, temporal reads
    dwar/         Dwar axios client
    ingest/       extract → validate → apply, spawning and bulk-changing a course's sessions
    recall/       anchor → expand → score → gate
    routers/v1/   HTTP routes + schemas; `GET /events` streams `changed` after every write so Thaali refetches instead of polling
    types/        domain types
  test/           Node test runner suites
  evals/          extraction eval cases from past mistakes + runner
  drizzle/        migrations
  prompts/        memory doctrine (shared) and extraction prompt
  config.toml
```

## Config vs env

`config.toml` (checked in, baked into the image): recall weights, ingest thresholds (including `segment_limit` and `segment_candidate_limit`, the per-line candidate search), HNSW, Dwar timeout/retry, page sizes. Every key is required; a missing one fails startup.

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

Extraction evals run the current extraction prompt (`prompts/memory.md` then `prompts/extraction.md`) through Dwar on cases taken from real ingests that went wrong, and write nothing. They need Dwar reachable at its mesh address and the box's `TZ`: `TZ=America/New_York npm run eval:extraction -- --runs=3` (`--case=<name>,<name>` runs only those). A run fails when an expectation fails or when Yaad would reject or re-extract the batch (the structural checks that need no database). Run them before shipping a prompt change, and add a case to `evals/extraction-cases.json` for every new kind of mistake an audit finds.

## CI / CD

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` → `ci` | PR + push to `main` | Postgres service, migrate, `npm test`, build images |
| `ci.yml` → `publish` | `main` after `ci` | Push `ghcr.io/<owner>/yaad:{latest,sha}` |

## Logging / error codes

Logs follow the nas JSON contract (`service=yaad`, request summary with `request_id` / `duration_ms`, errors with `code`). Default Fastify access logging is off.

HTTP errors: `{ "error": { "type": "<code>", "message": "..." } }`. Shared infra codes include `invalid_request`, `not_found`, `upstream_unreachable`, `internal_error`. Domain codes include `conflict`, `dwar`, `dimension_mismatch`, `extraction_failed`, `unlinked_node` (extraction created a node no edge in the batch touches). See nas README for the full shared catalog.

## Node kinds

| kind | what it is | detail table |
| --- | --- | --- |
| `person` | someone Dadi knows | `person_detail` (birthday, aliases) |
| `memory` | a thing that happened | none |
| `plan` | something with a real time: an event Ankur attends, one session of a class | `plan_detail` (end_at, all_day, time_zone, rsvp, attended) |
| `task` | something to do, relevant from an open day until a close | `task_detail` (opens_on, closes_at, done, verified_at) |
| `place` | somewhere you go | `place_detail` (address, latitude, longitude) |

`occurred_at` is the single "when" for every kind that has one: a plan's start (required), a memory's date. A task has none; its window is `task_detail`. Unknown dates are `NULL`. `expires_at` is null for permanent nodes; observations get a timestamp from `ttl_days`.

A plan has no status: it has a real start, so an invite or proposal with a time is a plan whose `rsvp` (whether Ankur is going: `yes`, `no`, or null until he answers) is null, and a plan called off is closed (`close_node`; history keeps a record). Unanswered and `yes` plans block his free time, `no` plans stay on the timeline. Whether Ankur was there is `attended` (`true` he went, `false` he did not, null until he says); a plan called off is closed, never `attended: false`. A value he set by hand stays unless the text says it changed. Something with no time ("dinner sometime next week") is never a plan: it is a Someday task. A task is relevant from `opens_on` (a local date) until `closes_at`; with neither it is Someday, and a close needs an open on or before its day. `done` says whether it is done and has no default: every insert states it, a create that does not say is not done, and a restating `noop` or verify never changes it. Each change of the flag, by ingest or by hand, appends a `node_history` row (`field` `done`, old and new `true` or `false`), which is how "done that day" is read. `verified_at` is the task's freshness: set when it is created, updated (any `update_node` on it), marked done or not done, or listed in a `noop`'s `node_ids` or `POST /tasks/verify` (extraction's way to say the text restated it as stored; nothing else changes, no history row, `updated_at` untouched). Null for tasks that predate it. A course hub (the source of a task's `HAS_ITEM`) has its own `verified_at` on `node`, stamped when any ingest or verify touches a task under it; recall reports it as `courses[<hub title>].verified_today`, computed in the box's time zone. A course not verified today is stale when the answer matters: check the source. Ingest decides every date; nothing in code or config derives a missing one.

## Places

A place is a real entity that recurs across events. Coordinates are optional. Yaad does not geocode. Convention: a plan links to its place with an `AT_LOCATION` edge (plan `src`, place `dst`); the place is a building whose `place_detail.address` is a full street address (clients open directions from it), and the room goes on the edge (`{"room": "1345"}`).

## Edge types

`edge.type` must be one of the types in `src/types/edges.ts`, which are exactly the types in the extraction prompt's §2.3 tables (a test holds the two lists equal). The `emit_operations` tool schema offers only those types, `create_edge` with any other is a 422 `invalid_request`, and ingest re-extracts once naming the types it may not use. When nothing fits, a link is `RELATED_TO` with a `relation` property. Adding a type is a code change that adds its row to the prompt. Migration `0013` renamed `HAS_SESSION` to `HAS_PLAN` and turned every stored edge outside the list into `RELATED_TO` with its old type kept as the property `was`, for the audit to re-type.

## Course plans

Recurrence is not stored. A class that meets twice a week is one plain plan per meeting, each linked to its course (a memory) by `HAS_PLAN` and to its place by `AT_LOCATION` with the room on the edge. The `spawn_plans` ingest op stamps them out from one template (title, local start and end times, rsvp, place, room) and a list of dates, so the model never writes each plan; they carry no embedding, so semantic recall finds the course and not every meeting. `update_plans` changes every plan of a course from a local date on (move the time, change the room, say no, or close the rest of the term). One plan moves, is called off, is marked attended, or gets a note (`HAS_NOTE`) by editing that plan. Recall's graph walk, ingest candidates and `POST /graph` skip `HAS_PLAN` edges, so a course's plans do not fill them; date filters, `GET /counts` and the planner show every plan. A course's pattern ("meets Tue and Thu 10:20 in room 1345") is a memory on the course; nothing computes from it.

## Memory doctrine

`prompts/memory.md` is the one statement of what memory is and is not, the node kinds, plan versus task by clock time, task windows (`opens_on`, `closes_at`) decided from the text, `rsvp`, called-off-is-closed, venue-is-where, the correction rule, and freshness. `loadExtractionPrompt` composes it before `prompts/extraction.md`, which holds only the write path's own rules (candidates, edges, operations, worked examples). Recall has no prompt: it is retrieval code (embedding, anchors, walk, score), so its LLM is the calling agent, and the contract that agent reads is the `recall_memory` and `ingest_memory` tool text in Hath, which reuses the doctrine's sentences verbatim. Change a doctrine sentence in `memory.md` and carry the same sentence to those tool descriptions and Hath's system prompt.

## Query vs recall

`recall` is the one read an agent needs: it anchors on a semantic `query`, explicit node ids, or the same exact filters `query` takes, then walks the graph. `query` is exact filters with offset paging and no graph walk — what the desktop widgets use for calendar windows.

## Corrections

Only agents write memory, through `POST /ingest` (`update_node`, `close_node`, `create_edge`, `close_edge`). There are no routes to create, edit or delete a node or an edge by hand, and ingest takes no request without an `agent_id`, so a node a request creates is always kept by an agent. Ankur's only hand writes are two marks in the planner: a task done or not, and whether he attended a plan. Changed fields write `node_history`, attributed to whoever made the change (`source`, and `agent_id` for an agent), while the node keeps its creator's. Edges use `valid_from`/`valid_to`; to change one, close it and create its replacement.

## Orphans

A node left with no current edge by a `close_edge` is deleted in the same transaction (with a `deleted` history row). Dated plans are kept: they stand on the timeline alone. `POST /ingest` returns the swept ids as `orphans`. `close_node` does not sweep: a called-off plan leaves its people and places in the graph. Nodes that were edgeless before the batch are not touched.

## Expiry

Observations may set `ttl_days`; expired nodes are filtered from recall/query/ingest candidates but not deleted. Only `memory`, `plan` and `task` may expire.

## Routes

| method | path | notes |
| --- | --- | --- |
| `GET` | `/health` | `{ "status": "ok" }` |
| `POST` | `/ingest` | extract and reconcile unstructured text |
| `POST` | `/recall` | graph retrieval anchored on a query, node ids, or filters |
| `POST` | `/query` | deterministic structured lookup |
| `GET` | `/nodes/:id` | node, detail, current edges |
| `GET` | `/counts` | live nodes per kind and in total: `{ total, kinds: { person, memory, place, plan, task } }`; every node is a memory, nothing is left out |
| `GET` | `/nodes/:id/history` | correction log |
| `POST` | `/history/search` | semantic search over `node_history` |
| `POST` | `/graph` | live subgraph for the Memory network view |
| `GET` | `/lint` | read-only report of suspicious live nodes; see Lint |
| `POST` | `/planner/plans` | every plan touching `{ from, to }`, earliest first; returns `{ items }`; see Planner |
| `PUT` | `/planner/plans/attended` | Ankur says whether he was at a plan: `{ plan_id, attended: boolean \| null }`; returns `{ plan_id, attended }`; 404 for an unknown or expired id, 422 for a node that is not a plan |
| `POST` | `/planner/tasks` | `{ on: "YYYY-MM-DD" }` or `{ someday: true }`; returns `{ items }`; see Tasks |
| `PUT` | `/planner/tasks/done` | Ankur sets or unsets done by hand: `{ task_id, done: boolean }`; returns `{ task_id, done }`, appends a `done` history row (source `manual`) when the flag changed, and stamps `verified_at` |
| `POST` | `/planner/tasks/verify` | restates tasks as still true with no extraction: `{ node_ids }`; stamps the tasks' and their course hubs' `verified_at`; 422 when one is not a task |

Unknown request fields are a 422.

Transitional aliases, to delete once the Thaali and Khisso planner releases are out: `POST /timeline` (the same plans read, with the `view` the apps used to ask the server to apply: `planner`, `month`, `tile`), `POST /tasks`, `PUT /tasks/done` and `PUT /timeline/attended`.

## Planner

Every plan is a stored row, agents write plans only through `POST /ingest`, and the app decides what to show of them: `POST /planner/plans` returns every plan touching `{ from, to }` (an all-day plan covers its day), and the day and week grid, the all-day band, the month and the home tile filter and lay them out themselves. Nothing is hidden: a declined plan is marked by `rsvp`, and a plan called off is closed and absent. Each item: `id`, `title`, `body`, `rsvp`, `start_at`, `end_at`, `all_day`, `time_zone`, `attended`, `place` (`{ id, title, address, room }`), `hub` (`{ id, title }` of the course it is a plan of, or null), `owner` (the plan's agent id, else its source) and its `notes`. Ankur's hand writes are `PUT /planner/plans/attended` and `PUT /planner/tasks/done`; RSVP and everything else change by messaging the plan's agent.

## Tasks

`POST /planner/tasks` with `on` returns, for that local day, the tasks not done whose open day has come (open, or past due when `closes_at` has passed: `past_due: true`), plus the tasks done that day or whose window held it, sorted by close time then title. With `someday: true` it returns tasks not done that have no window. Each item: `id`, `title`, `body`, `opens_on`, `closes_at`, `done`, `verified_at`, `created_at`, `updated_at`, `past_due`, `hub` (the course the task hangs off through `HAS_ITEM`, or null), `owner`. Everything is computed from stored dates; nothing is ranked or capped. `recall` and `query` take `relevant_on` (a local date) to anchor on the tasks not done whose open day has come by then and that have no close or closed within the 14 days before it, ordered closing on or after the day first (soonest first), then the recently past due (latest first), then open-ended; any filtered recall defaults to `page.max_size` results.

`recall` and `query` also take `hub` (a hub's id, its exact title, or a course label that starts a hub's normalized title, so "CSE 300" finds "CSE 300 class": what it holds by `HAS_ITEM` or `HAS_PLAN`; a label that matches no hub is a 422 naming the closest hub titles, never an empty result) and `closes_from` / `closes_to` (local dates, inclusive: tasks by close day, done ones included). A filter is a filter: when any is set, `recall` returns exactly the filtered rows, `query` only re-ranks them, and the graph is expanded only with explicit `hops`. `kind: "task"` with `occurred_from` / `occurred_to` is a 422 (tasks have no `occurred_at`). A recalled task's `detail` adds `closes_local` and `opens_local` (box time zone, with weekday, `Wed 2026-11-25 23:59`), `bucket` (`due_on_day`, `upcoming`, `past_due` against the `relevant_on` day, or today without it; null with no close, or when it closed before the day and is done) and `owner` (the agent that wrote its course hub), and the result's `courses` maps each returned task's hub title to `{ verified_at, verified_today, owner }`.

### `POST /graph`

Body: `{ seed_ids? }`. Without seeds: every live node. With seeds: the seeds plus all their live one-hop neighbors. `edges` are the current edges among the returned nodes. An unknown or expired seed is a 404.

### `POST /query`

Body: `{ kind?, name?, occurred_from?, occurred_to?, relevant_on?, limit?, offset? }`. At least one filter is required. Date bounds use interval overlap; undated rows are excluded when either bound is present.

## Ingest

`POST /ingest` takes `{ text, source_text?, occurred_at, participant_ids?, source }` (`source_text` is Ankur's own words verbatim; what a `close_node` may quote beside `text`; omit it when the caller has none), plus `agent_id` (kebab-case, required; `source` is always `"agent"`, and any other source is a 422). Every node the batch creates records that `agent_id`, so a node always belongs to an agent that can be messaged about it. Pipeline: embed the text and each of its lines or sentences (up to `ingest.segment_limit`) → assemble candidates in code (nearest live nodes to the whole text and to each segment; the tasks not done that close within the last 14 days or the next 60 or have no close, when they hang off a course the text touches (a nearest node is it or one of its tasks) or that the writing agent wrote, or share an identifying title word with the text; every person named by title, alias, or first or last name as a whole word; pinned participants) → Dwar `/chat/complete` with `emit_operations`, its `occurred_at` rewritten in the box's local offset → when a create resembles a live node extraction was not shown (same normalized title, a plan within 12 hours that shares a title word, or a task closing the same local day under the same hub), or a create has no edge in the batch, extraction runs once more with those nodes added and a `recheck` note saying which → validate the batch (structure, including a task window that closes before it opens or has a close and no open, then extraction guards: every `close_node` quotes its `evidence` from the text, every created node has an edge or is a `spawn_plans` hub or place, as `unlinked_node`) → apply in one transaction; a `create_edge` that a current edge already holds (same endpoints and type, properties already set) is skipped and counted as `edge_exists`. Nothing extraction emits is corrected in code: the result (`operations` applied with their ids and details, `counts`, `temp_ids`, `spawned`, `orphans`) is what was stored, and a window that looks wrong there is fixed by another ingest. Concurrent modification is 409.

Plans with `detail.all_day: true` have a date but no time of day: Yaad moves their `occurred_at` and `end_at` to local midnight of their dates (the box's `TZ`), so an all-day plan never carries an invented time. Absent `all_day` means a timed plan.

### Operations

| op | fields |
| --- | --- |
| `create_node` | `temp_id`, `kind`, `title`, `body?`, `occurred_at?`, `ttl_days?`, `detail?` |
| `update_node` | `node_id`, `title?`, `body?`, `occurred_at?`, `ttl_days?`, `detail?` |
| `close_node` | `node_id`, `reason`, `evidence` (the utterance or `source_text` words that retract it, quoted exactly) |
| `create_edge` | `src`, `dst`, `type`, `properties?`, `confidence` |
| `close_edge` | `edge_id`, `reason` |
| `spawn_plans` | `temp_id`, `hub` (course id or temp_id), `title`, `body?`, `dates` (local dates), `start_time`, `end_time?` (local HH:MM), `time_zone?`, `rsvp?`, `place?`, `room?`; creates one plan per date; a session that duplicates a live plan is `duplicate_node` by hand and left out by ingest; the result's `spawned` maps `temp_id` to the new ids |
| `update_plans` | `hub`, `from_date`, `to_date?`, `set` (`body?`, `rsvp?`, `attended?`, `start_time?`, `end_time?`, `room?`, or `close: true` alone, which closes each session as `close_node` does and keeps a history row); changes every session of the course in the range (one session when `to_date` = `from_date`), 422 when none match |
| `noop` | `reason`, optional `node_ids` (open tasks the text restates exactly as stored; each gets `verified_at` touched) |

The `emit_operations` tool schema has one `create_node` variant per kind: `memory` offers no `detail`, `plan` requires an `occurred_at`, `task` offers `detail.opens_on` / `closes_at` / `done`, and `person`/`place` offer only their own detail keys.

## Lint

`GET /lint` returns `{ findings: [{ rule, node_ids, title, note }] }` for live nodes that match what past audits found wrong: `status_snapshot` (as-of / not-yet wording on a memory that never expires), `working_note` (paths, branches, wakes, credentials, file names and line numbers, and lessons about how a site or tool behaves), `agent_instruction` (a rule for how agents work, which belongs in a charter), `noon_placeholder` (a timed plan at exactly 12:00 local), `dated_plan_title` (a plan title carrying a term, a month and day, a clock time, or a section), `dated_hub` (a plan that owns dated items through `HAS_ITEM` yet carries a date of its own), `long_span` (a one-off plan spanning more than a week, usually a period that is a rule), `duplicate` (any kind with the same normalized title, plans in the same hour), `unaliased_person` (a person whose first name is not an alias), `place_without_address` (a place plans are `AT_LOCATION` whose address is missing or has no building number and street), `floating` (a node with no current edge, which recall reaches only by similarity), `no_agent` (live nodes no agent keeps, one finding listing them all, so Message agent has nobody to reach) and `unknown_edge_type` (current edges whose type is not allowed, one finding per type). It never changes the graph.

## Recall

`POST /recall` takes `{ query?, from?, hops?, kind?, name?, occurred_from?, occurred_to?, relevant_on?, limit?, debug? }` and needs a `query`, `from`, or a filter.

| anchors | when |
| --- | --- |
| the `from` node ids (404 if one is unknown or expired) | `from` is set; it cannot be combined with filters |
| filter matches, ranked by similarity to `query` and capped at `recall.anchor_limit` | filters and `query` |
| filter matches in `/query` order, capped at `limit` | filters without `query` |
| up to 4 live plans and tasks whose title contains a word of the query (four letters or more, not generic, not a person's name or alias), nearest in time to now first, then ANN hits above `recall.anchor_similarity_floor`, together capped at `recall.anchor_limit` | `query` only |

`hops` (0 to `recall.hop_cap`) walks exactly that deep. Omitted, the walk is gated (hop cap, marginal yield, token budget) when there is a `query` and skipped otherwise, so `{ from: [id], hops: 1 }` is a node with its neighbors. With a `query`, nodes rank by score and `coverage` / `sufficient` are set; without one, nodes order by hop then `occurred_at` and `score`, `coverage`, `sufficient` are null. A walk from a `query` does not expand out of a node with more than 100 live edges (Ankur, a school): it is returned when reached, but its neighbors are not; an explicit `from` is always walked. `edges` are the current edges among the returned nodes. `debug: true` adds per-node score breakdown. Weights live in `[recall.weights]` in config.toml. Every returned node carries `created_at` and `updated_at`, and a task's `detail` carries `verified_at`, so a reader can tell a task last checked today from one last checked weeks ago.
