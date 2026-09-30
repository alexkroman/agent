// Copyright 2026 the AAI authors. MIT license.
/**
 * The published half of `stepMcp` — `sdk/step-mcp.ts` in `@alexkroman1/aai`
 * holds the contract, the slot and the argument for rejecting where the host
 * path degrades.
 *
 * It is `connectMcpServers` (`mcp-tools.ts`) with the step's `clientId` and the
 * agent env, which is the whole design: a server reached from a step is
 * resolved, SSRF-screened, namespaced, pinned and adapted by the same code
 * `withMcpTools` runs at host start, so the only differences are the ones the
 * two callers need — a client for the resolvers, and a rejection instead of a
 * degraded surface.
 *
 * The env is frozen into the connector at publish time, for the reason
 * `step-delegate.ts` freezes its own: a resolver's credential must not depend
 * on when in the run it happened to be reached.
 */

import type { StepMcp, StepMcpFn } from "@alexkroman1/aai/host-internal";
import { connectMcpServers, type McpToolsOptions } from "./mcp-tools.ts";
import type { Logger } from "./runtime-config.ts";

/**
 * Build the connector `installWorkflowSupport` publishes.
 *
 * `openSession` and `connectTimeoutMs` are the test seams `withMcpTools` takes;
 * leave them unset in production.
 *
 * @internal
 */
export function createStepMcp(
  options: {
    env?: Readonly<Record<string, string>> | undefined;
    logger: Logger;
  } & Pick<McpToolsOptions, "openSession" | "connectTimeoutMs">,
): StepMcpFn {
  const env = options.env ?? {};
  return async (servers, { clientId }): Promise<StepMcp> => {
    const connected = await connectMcpServers(servers, {
      env,
      logger: options.logger,
      clientId,
      openSession: options.openSession,
      connectTimeoutMs: options.connectTimeoutMs,
    });
    const down = connected.servers.filter((server) => server.unavailable !== undefined);
    if (down.length > 0) {
      await connected.close();
      throw new Error(
        `stepMcp could not connect ${down
          .map((server) => `"${server.key}" (${server.unavailable})`)
          .join(", ")}`,
      );
    }
    return {
      tools: connected.tools,
      servers: connected.servers.map((server) => ({ key: server.key, tools: server.tools })),
      close: connected.close,
    };
  };
}
