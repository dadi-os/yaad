export type NodeKind = "person" | "memory" | "plan";
export type NodeSource = "manual" | "agent" | "ingest";
export type PlanStatus = "idea" | "tentative" | "confirmed";

export type PersonDetail = {
  birthday: string | null;
  aliases: string[];
};

export type PlanDetail = {
  end_at: string | null;
  status: PlanStatus;
  recurrence: string | null;
};

export type NodeRecord = {
  id: string;
  kind: NodeKind;
  title: string;
  body: string | null;
  occurred_at: string | null;
  salience: number;
  access_count: number;
  last_accessed_at: string | null;
  source: NodeSource;
  created_at: string;
  valid_from: string;
  valid_to: string | null;
};

export type EdgeRecord = {
  id: string;
  src_id: string;
  dst_id: string;
  type: string;
  properties: Record<string, unknown>;
  confidence: number;
  created_at: string;
  valid_from: string;
  valid_to: string | null;
};
