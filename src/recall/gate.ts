/** Stopping criteria for recall hop expansion. */

export type GateReason = "yield" | "hop_cap" | "token_budget" | "continue";

export type GateDecision = {
  stop: boolean;
  reason: GateReason;
};

/** Rough token estimate: ceil(total title+body chars / 4). */
export function estimateTokens(nodes: Array<{ title: string; body: string | null }>): number {
  let chars = 0;
  for (const node of nodes) {
    chars += node.title.length + (node.body ? node.body.length : 0);
  }
  return Math.ceil(chars / 4);
}

/**
 * Decide whether to stop expanding: hop cap, marginal yield, or token budget.
 * Checked in that order; first match wins.
 */
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
