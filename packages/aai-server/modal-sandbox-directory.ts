// Copyright 2026 the AAI authors. MIT license.
/**
 * The Modal-backed {@link SandboxDirectory} — the fleet-wide "is some replica
 * already serving this deploy?" lookup.
 *
 * Split from the spawn paths because it is a pure READ of Modal's control
 * plane and shares nothing with a spawn but the client (modal-context.ts). See
 * sandbox-directory.ts for why a sandbox NAME replaced a heartbeated lease
 * table.
 */

import { errorMessage } from "@alexkroman1/aai";
import { GUEST_ROUTES, guestWsUrl } from "./guest-routes.ts";
import { createLogger } from "./logger.ts";
import { guestOrigin, type ModalSpawnContext, modalContext } from "./modal-context.ts";
import { agentSandboxName, type SandboxDirectory } from "./sandbox-directory.ts";

const log = createLogger("modal.directory");

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
        // `guestOrigin`, not a second `wss://host:port` spelling — it is the one
        // derivation of a guest's origin from a tunnel map, and a sandbox with no
        // tunnel for the harness port throws into the catch below, which is the
        // same "no sandbox" answer plus a line saying so.
        const origin = guestOrigin(await sb.tunnels());
        return { sessionUrl: guestWsUrl(origin, GUEST_ROUTES.session), guestOrigin: origin };
      } catch (err) {
        log.debug("Sandbox directory lookup failed", { name, error: errorMessage(err) });
        return null;
      }
    },
  };
}
