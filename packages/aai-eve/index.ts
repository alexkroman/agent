// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai-eve` — real-time voice for Vercel eve agents.
 *
 * The aai voice stack (STT/TTS providers, endpointing, barge-in, audio
 * pacing, the browser client protocol) packaged as an eve channel; the eve
 * agent supplies the replies. See `voice-channel.ts`.
 */

export {
  routeAgentHandle,
  type VoiceRouteArgsLike,
  type VoiceSessionLike,
} from "./route-agent-handle.ts";
export {
  bridgePeerSocket,
  type PeerSocketBridge,
  type VoicePeerLike,
} from "./session-socket-bridge.ts";
export { type VoiceChannelOptions, voiceChannel } from "./voice-channel.ts";
