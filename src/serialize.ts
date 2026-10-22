import type {
  EdgeRow,
  NodeHistoryRow,
  NodeRecordRow,
  NodeRow,
  PersonDetailRow,
  PlaceDetailRow,
  PlanDetailRow,
  PlannerBlockRow,
} from "./db/schema.js";
import type {
  EdgeRecord,
  NodeHistoryRecord,
  NodeKind,
  NodeRecord,
  NodeSource,
  PersonDetail,
  PlaceDetail,
  PlanDetail,
  PlanStatus,
} from "./types/domain.js";
import { YaadError } from "./errors.js";
import { PLANNER_ICONS, PLANNER_KINDS, type PlannerBlock, type PlannerIcon, type PlannerKind } from "./types/planner.js";

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function parseKind(value: string): NodeKind {
  if (value === "person" || value === "memory" || value === "plan" || value === "place") {
    return value;
  }
  throw new YaadError(500, "internal_error", `invalid node kind in database: ${value}`);
}

function parseSource(value: string): NodeSource {
  if (value === "manual" || value === "agent" || value === "ingest") {
    return value;
  }
  throw new YaadError(500, "internal_error", `invalid node source in database: ${value}`);
}

function parseStatus(value: string): PlanStatus {
  if (value === "idea" || value === "tentative" || value === "confirmed") {
    return value;
  }
  throw new YaadError(500, "internal_error", `invalid plan status in database: ${value}`);
}

function parsePlannerKind(value: string): PlannerKind {
  const kind = PLANNER_KINDS.find((known) => known === value);
  if (kind === undefined) {
    throw new YaadError(500, "internal_error", `invalid planner block kind in database: ${value}`);
  }
  return kind;
}

function parsePlannerIcon(value: string): PlannerIcon {
  const icon = PLANNER_ICONS.find((known) => known === value);
  if (icon === undefined) {
    throw new YaadError(500, "internal_error", `invalid planner block icon in database: ${value}`);
  }
  return icon;
}

function parseHistoryField(value: string): NodeHistoryRecord["field"] {
  if (value === "title" || value === "body" || value === "occurred_at" || value === "deleted") {
    return value;
  }
  throw new YaadError(500, "internal_error", `invalid node_history field in database: ${value}`);
}

export function toNodeRecord(row: NodeRecordRow): NodeRecord {
  return {
    id: row.id,
    kind: parseKind(row.kind),
    title: row.title,
    body: row.body,
    occurred_at: iso(row.occurredAt),
    expires_at: iso(row.expiresAt),
    access_count: row.accessCount,
    last_accessed_at: iso(row.lastAccessedAt),
    source: parseSource(row.source),
    agent_id: row.agentId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function toEdgeRecord(row: EdgeRow): EdgeRecord {
  return {
    id: row.id,
    src_id: row.srcId,
    dst_id: row.dstId,
    type: row.type,
    properties: row.properties,
    confidence: row.confidence,
    created_at: row.createdAt.toISOString(),
    valid_from: row.validFrom.toISOString(),
    valid_to: iso(row.validTo),
  };
}

export function toNodeHistoryRecord(row: NodeHistoryRow): NodeHistoryRecord {
  return {
    id: row.id,
    node_id: row.nodeId,
    field: parseHistoryField(row.field),
    old_value: row.oldValue,
    new_value: row.newValue,
    changed_at: row.changedAt.toISOString(),
    source: parseSource(row.source),
    agent_id: row.agentId,
  };
}

export function toPersonDetail(row: PersonDetailRow): PersonDetail {
  return {
    birthday: row.birthday,
    aliases: row.aliases,
  };
}

export function toPlanDetail(row: PlanDetailRow): PlanDetail {
  return {
    end_at: iso(row.endAt),
    all_day: row.allDay,
    status: parseStatus(row.status),
    recurrence: row.recurrence,
    series_id: null,
  };
}

export function toPlannerBlock(row: PlannerBlockRow, place: string | null, travelMin: number | null): PlannerBlock {
  return {
    id: row.id,
    start_at: row.startAt.toISOString(),
    end_at: row.endAt.toISOString(),
    title: row.title,
    note: row.note,
    place,
    travel_min: travelMin,
    kind: parsePlannerKind(row.kind),
    icon: parsePlannerIcon(row.icon),
    fixed: row.fixed,
    overlap_ok: row.overlapOk,
    done_at: iso(row.doneAt),
    source: row.source,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function toPlaceDetail(row: PlaceDetailRow): PlaceDetail {
  return {
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
  };
}

/** True when both dates are null or both mark the same instant. */
export function sameInstant(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.getTime() === right.getTime();
}

/** Text embedded for a correction row: "{old} → {new}". */
export function historyEmbeddingText(oldValue: string | null, newValue: string | null): string {
  return `${oldValue ?? ""} → ${newValue ?? ""}`;
}
