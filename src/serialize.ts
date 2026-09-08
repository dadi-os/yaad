import type {
  EdgeRow,
  NodeHistoryRow,
  NodeRow,
  PersonDetailRow,
  PlaceDetailRow,
  PlanDetailRow,
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

function parseHistoryField(value: string): NodeHistoryRecord["field"] {
  if (value === "title" || value === "body" || value === "occurred_at" || value === "deleted") {
    return value;
  }
  throw new YaadError(500, "internal_error", `invalid node_history field in database: ${value}`);
}

export function toNodeRecord(row: NodeRow): NodeRecord {
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
    status: parseStatus(row.status),
    recurrence: row.recurrence,
    series_id: row.seriesId,
  };
}

export function toPlaceDetail(row: PlaceDetailRow): PlaceDetail {
  return {
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
  };
}

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
