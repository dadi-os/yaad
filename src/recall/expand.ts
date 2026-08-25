import type { EdgeRow } from "../db/schema.js";

export type WalkNode = {
  hop: number;
  path: EdgeRow[];
  confidence: number;
};

export type WalkState = {
  nodes: Map<string, WalkNode>;
  frontier: string[];
};

export function initialWalk(anchorIds: string[]): WalkState {
  const nodes = new Map<string, WalkNode>();
  for (const id of anchorIds) {
    nodes.set(id, { hop: 0, path: [], confidence: 1 });
  }
  return { nodes, frontier: [...anchorIds] };
}

/** One BFS hop along `incident` in both directions. First visit wins; same hop keeps the higher confidence product. */
export function expandOneHop(state: WalkState, incident: EdgeRow[]): {
  next: WalkState;
  newlyDiscovered: string[];
} {
  const nextNodes = new Map(state.nodes);
  const newlyDiscovered: string[] = [];
  const frontierSet = new Set(state.frontier);
  const nextFrontier: string[] = [];

  for (const edge of incident) {
    const fromSrc = frontierSet.has(edge.srcId);
    const fromDst = frontierSet.has(edge.dstId);
    if (fromSrc) {
      consider(nextNodes, newlyDiscovered, nextFrontier, edge.dstId, edge.srcId, edge);
    }
    if (fromDst) {
      consider(nextNodes, newlyDiscovered, nextFrontier, edge.srcId, edge.dstId, edge);
    }
  }

  return {
    next: { nodes: nextNodes, frontier: nextFrontier },
    newlyDiscovered,
  };
}

function consider(
  nodes: Map<string, WalkNode>,
  newlyDiscovered: string[],
  nextFrontier: string[],
  target: string,
  via: string,
  edge: EdgeRow,
): void {
  const parent = nodes.get(via);
  if (!parent) {
    return;
  }
  const hop = parent.hop + 1;
  const confidence = parent.confidence * edge.confidence;
  const path = [...parent.path, edge];
  const existing = nodes.get(target);
  if (!existing) {
    nodes.set(target, { hop, path, confidence });
    newlyDiscovered.push(target);
    nextFrontier.push(target);
    return;
  }
  if (existing.hop === hop && confidence > existing.confidence) {
    nodes.set(target, { hop, path, confidence });
  }
}
