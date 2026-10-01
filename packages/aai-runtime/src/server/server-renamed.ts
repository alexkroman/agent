// Copyright 2026 the AAI authors. MIT license.
/**
 * Published names this directory renamed, kept working under the old name.
 *
 * Its own module because `server.ts` is at the source-length cap.
 */

import { createServerForRuntime } from "./server.ts";
import type { AgentServer, RuntimeServerOptions } from "./types.ts";

/**
 * Serve a runtime you already have over HTTP + WebSocket.
 *
 * @deprecated Renamed {@link createServerForRuntime}, which this calls
 * unchanged. To serve an agent definition, `createAgentServer` builds the
 * runtime for you; for host mode, `createHostServer`.
 *
 * @public
 */
export function createRuntimeServer(options: RuntimeServerOptions): AgentServer {
  return createServerForRuntime(options);
}
