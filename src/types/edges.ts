/** The edge types yaad accepts, which the extraction prompt (§2.3) teaches and the planner reads. */

/**
 * Every edge type a write may use. A type outside this list is rejected, so a typo cannot
 * silently detach a node from its course; `RELATED_TO` with a `relation` property is the one
 * place for a link nothing else fits. Adding a type is a code change that also adds its row to
 * the prompt's table.
 */
export const EDGE_TYPES = [
  "LIVES_AT",
  "ATTENDS",
  "ATTENDED",
  "WORKS_AT",
  "WORKED_AT",
  "FREQUENTS",
  "FROM",
  "ROOMMATE_OF",
  "FRIEND_OF",
  "PARTNER_OF",
  "SIBLING_OF",
  "PARENT_OF",
  "FAMILY_OF",
  "COWORKER_OF",
  "CLASSMATE_OF",
  "KNOWS",
  "ABOUT",
  "PREFERS",
  "DISLIKES",
  "PARTICIPANT",
  "ENROLLED_IN",
  "TEACHES",
  "MEMBER_OF",
  "WORKS_ON",
  "OWNS",
  "HAS_FACET",
  "HAS_ITEM",
  "HAS_PLAN",
  "HAS_NOTE",
  "FOR",
  "AT_LOCATION",
  "RELATED_TO",
] as const;

export type EdgeType = (typeof EDGE_TYPES)[number];

/** True when `value` is an allowed edge type. */
export function isEdgeType(value: string): value is EdgeType {
  return EDGE_TYPES.some((type) => type === value);
}
