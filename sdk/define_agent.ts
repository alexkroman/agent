// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent definition factory.
 *
 * @module
 */

import {
  type AgentDef,
  type AgentOptions,
  DEFAULT_GREETING,
  DEFAULT_INSTRUCTIONS,
  normalizeTransport,
} from "./types.ts";

/**
 * Create an agent definition from the given options, applying sensible defaults.
 *
 * This is the main entry point for defining a voice agent. The returned
 * {@linkcode AgentDef} is consumed by the AAI server at deploy time.
 *
 * @param options Configuration for the agent including name, instructions,
 *   tools, hooks, and transport settings.
 * @returns A fully resolved agent definition with all defaults applied.
 *
 * @example Basic agent with a custom tool
 * ```ts
 * import { defineAgent } from "aai";
 * import { z } from "zod";
 *
 * export default defineAgent({
 *   name: "greeter",
 *   instructions: "You greet people warmly.",
 *   tools: {
 *     greet: {
 *       description: "Greet a user by name",
 *       parameters: z.object({ name: z.string() }),
 *       execute: ({ name }) => `Hello, ${name}!`,
 *     },
 *   },
 * });
 * ```
 */
export function defineAgent<S>(options: AgentOptions<S>): AgentDef {
  // AgentDef erases the S generic (it's a runtime artifact consumed by the
  // server which doesn't need the compile-time state type). The cast is safe
  // because AgentDef's hooks/tools use the same shapes with `any`/`unknown`.
  return {
    name: options.name,
    env: options.env ?? ["ASSEMBLYAI_API_KEY"],
    transport: normalizeTransport(options.transport),
    mode: options.mode ?? "s2s",
    instructions: options.instructions ?? DEFAULT_INSTRUCTIONS,
    greeting: options.greeting ?? DEFAULT_GREETING,
    voice: options.voice ?? "",
    ...(options.sttPrompt !== undefined && { sttPrompt: options.sttPrompt }),
    maxSteps: options.maxSteps ?? 5,
    ...(options.toolChoice !== undefined && { toolChoice: options.toolChoice }),
    ...(options.builtinTools !== undefined && { builtinTools: options.builtinTools }),
    ...(options.activeTools !== undefined && { activeTools: options.activeTools }),
    tools: options.tools ?? {},
    ...(options.state !== undefined && { state: options.state }),
    ...(options.onConnect !== undefined && { onConnect: options.onConnect }),
    ...(options.onDisconnect !== undefined && { onDisconnect: options.onDisconnect }),
    ...(options.onError !== undefined && { onError: options.onError }),
    ...(options.onTurn !== undefined && { onTurn: options.onTurn }),
    ...(options.onStep !== undefined && { onStep: options.onStep }),
    ...(options.onBeforeStep !== undefined && { onBeforeStep: options.onBeforeStep }),
  } as AgentDef;
}
