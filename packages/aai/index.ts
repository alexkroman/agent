// Copyright 2025 the AAI authors. MIT license.
/**
 * AAI SDK — build voice agents powered by STT, LLM, and TTS.
 *
 * Agents are defined as directories with `agent.json` + `tools/*.ts` +
 * `hooks/*.ts`. Use {@link parseManifest} to validate `agent.json` at
 * build time.
 *
 * @example
 * ```ts
 * import { parseManifest } from "aai";
 *
 * const manifest = parseManifest(JSON.parse(fs.readFileSync("agent.json", "utf-8")));
 * ```
 */

export type { Kv } from "./isolate/kv.ts";
export {
  type HookFlags,
  type Manifest,
  parseManifest,
  type ToolManifest,
} from "./isolate/manifest.ts";
export type { BuiltinTool, Message, ToolResultMap } from "./isolate/types.ts";
