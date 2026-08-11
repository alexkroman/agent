// Copyright 2026 the AAI authors. MIT license.
/**
 * What `createServer` does with a WebSocket upgrade it will not serve normally —
 * the two refusals and the host-mode branch.
 *
 * Split out of `server.ts` when that file reached the file-length cap, and the
 * seam is real: everything here answers "this connection is not an ordinary
 * session", which is three of the four outcomes an upgrade can have.
 */

import type { AgentDef } from "../sdk/types.ts";
import type { parseWsUpgradeParams } from "../sdk/ws-upgrade.ts";
import { isHostAllowed, startHostSession } from "./host-mode.ts";
import { consoleLogger, type Logger } from "./runtime-config.ts";
// Type-only, so it is erased at build and the apparent cycle with `server.ts`
// (which imports this module's values) never exists at run time. Imported rather
// than re-declared because a local alias is a SECOND `SessionRuntime` as far as
// TypeDoc is concerned — it warned that `decliningRuntime` referenced an
// undocumented type, which `treatWarningsAsErrors` turns into a failed docs
// build.
import type { SessionRuntime } from "./server.ts";
import { type SessionWebSocket, safeSend } from "./ws-handler.ts";

/**
 * A {@link SessionRuntime} that turns every session away with a protocol error
 * and closes, instead of accepting a socket it cannot answer.
 *
 * For a server whose `/websocket` has no agent behind it — `createHostServer`,
 * which serves only `?host=1` sessions. The guest harness hand-rolls the same
 * shape for its drain refusal; this is here so the third one does not get
 * written by hand too.
 *
 * A refusal must SAY something: closing a bare socket leaves the client
 * reconnecting against a server that will never answer, with nothing in the
 * frame log explaining why.
 */
export function decliningRuntime(message: string, logger: Logger = consoleLogger): SessionRuntime {
  return {
    startSession(ws) {
      safeSend(ws, JSON.stringify({ type: "error", code: "protocol", message }), logger);
      ws.close?.(1008);
    },
    shutdown: () => Promise.resolve(),
  };
}

/** What a `/websocket` dial against a static-page agent is told. */
export const STATIC_PAGE_REFUSAL =
  "This app has no voice session — its page is static and talks to the workflow API. " +
  'Set `page: "voice"` on the agent to serve sessions.';

/**
 * Serve a `?host=1` connection, or refuse it with a reason.
 *
 * Lifted out of the upgrade handler because it is the one branch with its own
 * gate (`AAI_ALLOW_HOST`) and its own refusal, and inline it made that handler's
 * complexity exceed the lint ceiling — which was fair: three refusals and two
 * ways to start a session in one callback.
 */
export function startOrRefuseHostSession(
  session: SessionWebSocket,
  ctx: {
    env: Record<string, string> | undefined;
    hostBaseAgent: AgentDef | undefined;
    startOpts: ReturnType<typeof parseWsUpgradeParams>;
    logger: Logger;
    url: string;
  },
): void {
  const { env, hostBaseAgent, startOpts, logger, url } = ctx;
  // Requires `env` — it is both the gate and the source of secrets for the
  // per-connection runtime. Deferred `startSession`: the first `config` frame
  // supplies the agent.
  if (env && isHostAllowed(env)) {
    logger.info(`WS upgrade ${url} (host mode)`);
    startHostSession(session, {
      env,
      startOpts,
      logger,
      ...(hostBaseAgent ? { baseAgent: hostBaseAgent } : {}),
    });
    return;
  }
  logger.warn(`WS upgrade ${url} rejected: host mode unavailable`);
  decliningRuntime("host mode is not enabled on this server", logger).startSession(session);
}
