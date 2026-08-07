// Copyright 2026 the AAI authors. MIT license.
// Draining one LLM stream's entries into the shared part handler.
//
// Split from `pipeline-llm-stream.ts` for the file-length cap. Both the
// ordinary and the adopted (preemptive-generation) paths drain through
// `drainEntries`, which is what keeps the two indistinguishable downstream.

import type { ModelMessage } from "ai";
import type { TapeEntry } from "./pipeline-llm-stream.ts";
import type { StreamPart, StreamPartHandler } from "./pipeline-stream-parts.ts";

/** Wrap a plain part stream as tape entries, so both paths drain one shape. */
export async function* partsAsEntries(parts: AsyncIterable<StreamPart>): AsyncGenerator<TapeEntry> {
  for await (const part of parts) yield { kind: "part", part };
}

/**
 * Feed one stream's entries through the handler until it ends, the turn aborts,
 * or — on the adopted path only — a tool call proves the run unusable.
 *
 * Extracted from {@link consumeLlmStream} so the restart loop there stays
 * readable (and under the complexity cap).
 */
export async function drainEntries(
  entries: AsyncIterable<TapeEntry>,
  handler: StreamPartHandler,
  opts: {
    /** Adopted runs stop at a tool call; ordinary ones execute it. */
    adopted: boolean;
    signal: AbortSignal;
    collected: ModelMessage[];
    onStepPersisted?: (() => void) | undefined;
    /** Per-turn timing; sees every part, including the ones handled below. */
    trace?: { onPart(kind: string): void } | undefined;
  },
): Promise<{ lateToolCall: boolean; spokeBeforeRestart: boolean }> {
  let lateToolCall = false;
  let spokeBeforeRestart = false;
  for await (const entry of entries) {
    if (opts.signal.aborted) break;
    if (entry.kind === "step") {
      // A step marker fires `onStepPersisted` exactly where it did while the
      // speculation was running — the transport snapshots how much of the
      // transcript that step covers, and a replay that batched them at the end
      // would put the `[interrupted]` split in the wrong place.
      opts.collected.push(...entry.messages);
      opts.onStepPersisted?.();
      continue;
    }
    // Before the adopted-run break below, so a late tool call is still timed —
    // that turn is about to be restarted and its cost is the thing worth seeing.
    opts.trace?.onPart(entry.part.type);
    if (opts.adopted && entry.part.type === "tool-call") {
      lateToolCall = true;
      break;
    }
    if (entry.part.type === "text-delta") spokeBeforeRestart = true;
    handler.handle(entry.part);
  }
  return { lateToolCall, spokeBeforeRestart };
}
