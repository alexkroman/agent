// Copyright 2025 the AAI authors. MIT license.
/**
 * Hono framework type bindings for the platform server.
 *
 * `HonoEnv` defines the Bindings (server-level singletons injected via
 * `app.fetch(req, bindings)`) and Variables (per-request values set by
 * middleware like `slugMw` and `authMw`).
 *
 * Not to be confused with OS environment variables or agent env/secrets.
 */

import type { Context } from "hono";
import type { Storage } from "unstorage";
import type { BundleStore } from "./store-types.ts";

export type HonoEnv = {
  Bindings: {
    slots: import("./sandbox-slots.ts").SlotCache;
    store: BundleStore;
    storage: Storage;
  };
  Variables: {
    slug: string;
    apiKey: string;
    keyHash: string;
  };
};

/** Typed context for route handlers using the platform {@link HonoEnv}. */
export type AppContext = Context<HonoEnv>;

/** Context for handlers whose JSON body was pre-validated by `zValidator`. */
export type ValidatedAppContext<T> = Context<
  HonoEnv,
  string,
  { in: { json: T }; out: { json: T } }
>;
