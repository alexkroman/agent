// Copyright 2026 the AAI authors. MIT license.
/**
 * The AssemblyAI speech-to-speech WIRE client: `connectS2s` (`client.ts`) and
 * the message parsing, dispatch and reply bookkeeping behind it. What the S2S
 * transport (`transports/s2s-transport.ts`) and the S2S fuzz drive. Outside this
 * directory, import from here; a name not re-exported here is private to it
 * (`module-boundaries.test.ts`).
 */

export type { CreateS2sWebSocket, S2sCallbacks, S2sHandle, S2sSessionConfig } from "./client.ts";
export { connectS2s, defaultCreateS2sWebSocket } from "./client.ts";
