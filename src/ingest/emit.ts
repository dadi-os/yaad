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
 * Run one reasoning turn that must call `emit_operations` exactly once.
 * Rejects non-tool_use stops or wrong tool call counts.
 */
export async function emitOperations(opts: {
  dwar: DwarClient;
  config: Config;
  occurredAt: string;
  text: string;
  candidates: CandidateState;
}): Promise<Operation[]> {
  const system = loadExtractionPrompt(opts.config.serviceRoot);
  const user = JSON.stringify({
    occurred_at: opts.occurredAt,
    text: opts.text,
    candidates: opts.candidates,
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
