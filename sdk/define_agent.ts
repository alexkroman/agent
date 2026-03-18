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
} from "./types.ts";

/**
 * Create an agent definition from the given options, applying sensible defaults.
 *
 * This is the main entry point for defining a voice agent. The returned
 * {@linkcode AgentDef} is consumed by the AAI server at deploy time.
 *
 * @param options Configuration for the agent including name, instructions,
 *   tools, hooks, and other settings.
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
  const def: AgentDef = {
    name: options.name,
    instructions: options.instructions ?? DEFAULT_INSTRUCTIONS,
    greeting: options.greeting ?? DEFAULT_GREETING,
    voice: options.voice ?? "",
    maxSteps: options.maxSteps ?? 5,
    tools: options.tools ?? {},
  } as AgentDef;
  copyOptionalFields(options, def);
  return def;
}

const OPTIONAL_KEYS = [
  "sttPrompt",
  "toolChoice",
  "builtinTools",
  "activeTools",
  "state",
  "onConnect",
  "onDisconnect",
  "onError",
  "onTurn",
  "onStep",
  "onBeforeStep",
] as const;

function copyOptionalFields<S>(src: AgentOptions<S>, dst: AgentDef): void {
  for (const key of OPTIONAL_KEYS) {
    const val = src[key];
    if (val !== undefined) {
      (dst as Record<string, unknown>)[key] = val;
    }
  }
}
