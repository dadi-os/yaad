export type GateReason = "yield" | "hop_cap" | "token_budget" | "continue";

export type GateDecision = {
  stop: boolean;
  reason: GateReason;
};

export function estimateTokens(nodes: Array<{ title: string; body: string | null }>): number {
  let chars = 0;
  for (const node of nodes) {
    chars += node.title.length + (node.body ? node.body.length : 0);
  }
  return Math.ceil(chars / 4);
}

export function shouldStop(opts: {
  hopsTaken: number;
  hopCap: number;
  newRelevantCount: number;
  marginalYieldMinimum: number;
  tokenEstimate: number;
  tokenBudget: number;
}): GateDecision {
  if (opts.hopsTaken >= opts.hopCap) {
    return { stop: true, reason: "hop_cap" };
  }
  if (opts.newRelevantCount < opts.marginalYieldMinimum) {
    return { stop: true, reason: "yield" };
  }
  if (opts.tokenEstimate >= opts.tokenBudget) {
    return { stop: true, reason: "token_budget" };
  }
  return { stop: false, reason: "continue" };
}
