// Copyright 2025 the AAI authors. MIT license.
/** Pipeline session context — base ctx + STT/TTS session slots. */

import type { AgentConfig, ExecuteTool } from "../sdk/_internal-types.ts";
import type { ClientSink } from "../sdk/protocol.ts";
import type { SttSession, TtsSession } from "../sdk/providers.ts";
import type { Logger } from "./runtime-config.ts";
import { _buildBaseCtx, type BaseSessionCtx } from "./session-ctx.ts";

/**
 * Pipeline session context — {@link BaseSessionCtx} plus STT/TTS provider
 * session handles. Replaces the S2S `s2s` field with decoupled `stt` + `tts`
 * slots so the pipeline orchestrator can drive independent providers.
 */
export type PipelineSessionCtx = BaseSessionCtx & {
  stt: SttSession | null;
  tts: TtsSession | null;
};

export function buildPipelineCtx(opts: {
  id: string;
  agent: string;
  client: ClientSink;
  agentConfig: AgentConfig;
  executeTool: ExecuteTool;
  log: Logger;
  maxHistory?: number | undefined;
}): PipelineSessionCtx {
  // Mutate the base ctx in place rather than spreading into a new object —
  // the helper methods close over the base ctx reference, so spreading would
  // leave them writing to an orphan object.
  const base = _buildBaseCtx(opts) as PipelineSessionCtx;
  base.stt = null;
  base.tts = null;
  return base;
}
