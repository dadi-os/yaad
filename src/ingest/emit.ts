/** Ask Dwar to emit ingest operations via the `emit_operations` tool. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { DwarClient } from "../dwar/client.js";
import { YaadError } from "../errors.js";
import { formatZod } from "../routers/v1/schemas.js";
import type { CandidateState } from "./candidates.js";
import { emitOperationsInput, emitOperationsToolSchema, type Operation } from "./operations.js";

/** Load `prompts/extraction.md` from the service root. */
export function loadExtractionPrompt(serviceRoot: string): string {
  return readFileSync(join(serviceRoot, "prompts/extraction.md"), "utf8");
}

/**
 * `iso` rewritten in the box's local zone with its offset (`2026-09-30T20:06:19-04:00`).
 * Callers send UTC; extraction reads local times in the utterance against this offset.
 * The process runs in the box's zone (`TZ`), so local is the box's.
 */
function localIso(iso: string): string {
  const at = new Date(iso);
  const pad = (value: number) => String(Math.abs(value)).padStart(2, "0");
  const offset = -at.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

/**
 * recheckNote tells extraction on its second pass what its first pass got wrong: it
 * created lookalikes of nodes it had not been shown (now added to candidates), or it
 * created nodes with no edge.
 */
export function recheckNote(opts: {
  lookalikes: boolean;
  unlinked: Extract<Operation, { op: "create_node" }>[];
}): string {
  const notes: string[] = [];
  if (opts.lookalikes) {
    notes.push(
      "A first pass on this utterance created nodes that look like existing ones it had not been shown. Those nodes are now in candidates: reuse or update them instead of creating a second copy.",
    );
  }
  if (opts.unlinked.length > 0) {
    const titles = opts.unlinked.map((op) => `"${op.title}"`).join(", ");
    notes.push(
      `A first pass created nodes with no edge: ${titles}. Every node you create needs at least one edge in this batch, to its subject, its hub, or Ankur (§5.3); link each one, or leave it out if it is not worth storing.`,
    );
  }
  return notes.join(" ");
}

/**
 * Run one reasoning turn that must call `emit_operations` exactly once.
 * Rejects non-tool_use stops or wrong tool call counts.
 */
export async function emitOperations(opts: {
  dwar: DwarClient;
  config: Pick<Config, "serviceRoot">;
  occurredAt: string;
  text: string;
  candidates: CandidateState;
  /** On the second pass, what the first pass got wrong (see {@link recheckNote}); null on the first. */
  recheck: string | null;
}): Promise<Operation[]> {
  const system = loadExtractionPrompt(opts.config.serviceRoot);
  const user = JSON.stringify({
    occurred_at: localIso(opts.occurredAt),
    text: opts.text,
    candidates: opts.candidates,
    ...(opts.recheck !== null ? { recheck: opts.recheck } : {}),
  });
  const response = await opts.dwar.reason({
    system,
    user,
    tools: [
      {
        name: "emit_operations",
        description:
          "Emit the memory operations to apply for this utterance. Call this tool exactly once.",
        input_schema: emitOperationsToolSchema,
      },
    ],
    caller: "yaad/ingest",
  });
  if (response.stop_reason !== "tool_use") {
    throw new YaadError(
      502,
      "extraction_failed",
      `Dwar returned stop_reason ${response.stop_reason} instead of tool_use`,
    );
  }
  const uses = response.content.filter((block) => block.type === "tool_use");
  const emit = uses.filter((block) => block.type === "tool_use" && block.name === "emit_operations");
  if (emit.length !== 1) {
    throw new YaadError(
      502,
      "extraction_failed",
      `expected exactly one emit_operations tool call, got ${emit.length}`,
    );
  }
  const block = emit[0];
  if (!block || block.type !== "tool_use") {
    throw new YaadError(502, "extraction_failed", "emit_operations tool call missing");
  }
  const parsed = emitOperationsInput.safeParse(block.input);
  if (!parsed.success) {
    throw new YaadError(
      502,
      "extraction_failed",
      `emit_operations input failed validation: ${formatZod(parsed.error)}`,
    );
  }
  return parsed.data.operations;
}
