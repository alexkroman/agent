// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 10.
 *
 * **Epoch 11 is COLLATERAL**, as epoch 10 was. The export list did not change
 * and no helper here changed signature. What moved is the declaration they are
 * pointed AT: `AgentDef` gained an optional `turnDetection` field (push-to-talk,
 * through `PipelineVoiceTuning`), and `AgentConfigSchema` — reachable from this
 * subpath through `AgentConfigSource`, what `expectDeployable` takes — gained
 * the matching member.
 *
 * ## Why this file carries no roll-call
 *
 * `v2.ts` through `v9.ts` are retained and between them name every export, and
 * epoch 10 added no name to epoch 9's list. What is left is an epoch-10 spec
 * body over the helper the moving declaration flows through, for an agent that
 * leaves the new field out.
 *
 * **Its specifiers are RELATIVE**, for the reason every frozen example's are.
 *
 * @module
 */

import { agent } from "../../../index.ts";
import { expectDeployable } from "../../../sdk/testing-barrel.ts";

/** The AUTHORED def — no `turnDetection`, so the transcriber ends each turn. */
const authored = agent({
  name: "Front desk",
  systemPrompt: "Answer in one or two sentences.",
});

/** `expectDeployable` takes what an epoch-10 author wrote and answers the resolved config. */
export function itDeploys(): string | undefined {
  const config = expectDeployable(authored);
  return config.turnDetection ?? config.name;
}
