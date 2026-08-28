// Copyright 2026 the AAI authors. MIT license.
/**
 * FROZEN starter — `aai-runtime:text`, epoch 2.
 *
 * `aai-runtime`'s compatibility examples are written as a starter a HOST
 * copies, because that is what its consumers do with this package (see "The
 * published surface is versioned in epochs" in its guide).
 *
 * Epoch 3 added `temperature` to `TextTurnOptions`, and `AgentDef` gained the
 * field it falls back to. Both are optional, so epoch 2 is RETAINED: a host
 * that never mentions temperature is unaffected, which is what this file
 * tests. Do not edit it to make a compile error go away — the error IS the
 * finding.
 */

import { agent } from "@alexkroman1/aai";
import {
  createTextAgent,
  type TextAgent,
  type TextAgentOptions,
  type TextTurnOptions,
  type TextTurnResult,
} from "../../../runtime-barrel.ts";

/** The options a host assembled at epoch 2. */
export function optionsFor(sessionId: string): TextAgentOptions {
  return {
    agent: agent({ name: "Docs Assistant", text: true, systemPrompt: "Answer from the docs." }),
    sessionId,
  };
}

/** Building the agent, and driving one turn. */
export function runTurn(sessionId: string, question: string): TextTurnResult {
  const built: TextAgent = createTextAgent(optionsFor(sessionId));
  const turn: TextTurnOptions = {
    messages: [{ role: "user", content: question }],
    maxSteps: 6,
  };
  return built.stream(turn);
}

/** The two readonly members a host reads back off the handle. */
export function describe(built: TextAgent): string {
  return `${built.sessionId}: ${Object.keys(built.tools).length} tool(s)`;
}
