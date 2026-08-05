// Copyright 2026 the AAI authors. MIT license.
/**
 * The Modal-backed {@link SandboxDirectory} — the fleet-wide "is some replica
 * already serving this deploy?" lookup.
 *
 * Split from modal-sandbox.ts (spawning) because it is a pure READ of Modal's
 * control plane and shares nothing with a spawn but the client. See
 * sandbox-directory.ts for why a sandbox NAME replaced a heartbeated lease
 * table.
 */

import { errorMessage } from "@alexkroman1/aai";
import { debug } from "./_debug-log.ts";
import { GUEST_ROUTES, guestWsUrl } from "./guest-routes.ts";
import { GUEST_PORT, type ModalSpawnContext, modalContext } from "./modal-sandbox.ts";
import { agentSandboxName, type SandboxDirectory } from "./sandbox-directory.ts";

/**
 * The Modal-backed {@link SandboxDirectory}: ask Modal whether a RUNNING
 * sandbox holds this deploy's name, and if so where its tunnel is.
 *
 * Never throws. A lookup that fails for any reason reads as "no sandbox" and
 * the caller spawns — where the name itself catches a duplicate. That is the
 * right failure direction: a false miss costs one extra sandbox at worst,
 * while a thrown lookup would fail a broker call that could have been served.
 */
export function createModalSandboxDirectory(ctx?: ModalSpawnContext): SandboxDirectory {
  return {
    async find(slug, version) {
      const name = agentSandboxName(slug, version);
      try {
        const context = ctx ?? (await modalContext());
        const sb = await context.lookupGuestSandbox(name);
        if (!sb) return null;
        const tunnels = await sb.tunnels();
        const tunnel = tunnels[GUEST_PORT];
        if (!tunnel) return null;
        const origin = `wss://${tunnel.host}:${tunnel.port}`;
        return { sessionUrl: guestWsUrl(origin, GUEST_ROUTES.session), guestOrigin: origin };
      } catch (err) {
        debug("Sandbox directory lookup failed", { name, error: errorMessage(err) });
        return null;
      }
    },
  };
}
