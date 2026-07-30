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

import type { Vector } from "@alexkroman1/aai/runtime";
import type { Context } from "hono";
import type { Storage } from "unstorage";
import type { SlotCache } from "./sandbox-slots.ts";
import type { BundleStore } from "./store-types.ts";

export type HonoEnv = {
  Bindings: {
    slots: SlotCache;
    store: BundleStore;
    storage: Storage;
    /**
     * Backing store for the platform-default KV. Upstash Redis when
     * configured, else the same instance as `storage` (see kv-storage.ts).
     * KV consumers must use this, never `storage` — the two differ in
     * production.
     */
    kvStorage: Storage;
    defaultVector: (slug: string) => Vector;
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
