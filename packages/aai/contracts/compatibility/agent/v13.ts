// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 13.
 *
 * **Moved for a TRANSITIVE reason.** Nothing on this capability's own surface
 * was added, removed or renamed — the export list is identical to epoch 12's.
 * What changed is `AssemblyAITtsOptions`, which gained `streamingUrl` (the
 * endpoint override a sandbox cluster is reached by) and marked `host`
 * deprecated; `assemblyAIPipeline()` returns an `AssemblyAITtsProvider`, whose
 * `options` are that type, so it reaches this capability's report as a
 * forgotten export. A capability's hash covers the shape a consumer has to
 * satisfy, so a type reachable FROM the surface is part of it. Epoch 12 is
 * RETAINED and `./v12.ts` compiles unchanged beside this file.
 *
 * So this is epoch 12's agent with the field the moved type hangs off made
 * explicit: the all-AssemblyAI preset spread in, which is what an author writes
 * when they want the three stages visible in the config rather than filled in
 * by omission.
 *
 * See `./v3.ts` for what "frozen" obliges and why the imports are relative.
 */

import { agent, assemblyAIPipeline, sessionSlot } from "../../../index.ts";

const auditSlot = sessionSlot("audit", () => ({ seen: [] as string[] }));

/** The preset is the explicit spelling of the default pipeline. */
export const pipeline = assemblyAIPipeline({ voice: "jane" });

/** A stage may be replaced whole — which re-declares that stage's own options. */
export const sandboxTts = { ...pipeline.tts.options };

export default agent({
  name: "Provisioned",
  greeting: "What can I get you?",
  ...pipeline,
  syncState: auditSlot.projection((audit) => ({ count: audit.seen.length })),
});
