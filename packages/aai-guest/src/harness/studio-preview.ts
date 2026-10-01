// Copyright 2026 the AAI authors. MIT license.
/**
 * Studio mode's preview server: the loaded bundle's OWN `createRuntimeServer`,
 * rebuilt whenever a different bundle loads.
 *
 * The harness carries no runtime ("User-shipped runtime" in this package's
 * guide), so the server shell a preview session, its workflow API and its client
 * config run on has to come from the same copy as the session runtime — the
 * bundle's `__aaiCreateRuntime.host`. Two copies meeting there is what split the
 * run context and the metrics sinks before: a step's progress was reported into
 * the server copy's store while the engine walked in the bundle's.
 *
 * Built lazily on the first request that needs one, and NEVER listening: the
 * harness owns the port and hands each request and upgrade to `node`.
 *
 * @module
 */

import { errorMessage } from "@alexkroman1/aai";
import { type HarnessState, lazyRuntime } from "aai-guest-core/bundle";
import type { CreateGuestRuntime, GuestHost } from "aai-guest-core/types";

/** The part of a built server the harness forwards to. */
export type PreviewServer = Pick<ReturnType<GuestHost["createRuntimeServer"]>, "node" | "close">;

/** The current preview server, or `undefined` while no bundle is loaded. */
export type StudioPreview = { current(): PreviewServer | undefined };

/** See the module doc. */
export function studioPreview(state: HarnessState): StudioPreview {
  let built: { for: CreateGuestRuntime; server: PreviewServer } | undefined;
  return {
    current() {
      const factory = state.createRuntime;
      const host = state.host;
      if (factory === null || host === null) return;
      if (built?.for === factory) return built.server;
      // A new bundle replaced the one the old server was built over: drop it
      // (its sessions were already torn down by `loadBundle`) and build anew.
      const stale = built?.server;
      if (stale) {
        void stale.close().catch((err: unknown) => {
          console.error(`studio preview: closing the previous server: ${errorMessage(err)}`);
        });
      }
      const server = host.createRuntimeServer({ runtime: lazyRuntime(state) });
      built = { for: factory, server };
      return server;
    },
  };
}
