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
import type { AppDatabases } from "./app-database.ts";
import type { SlugEpochs } from "./platform-epoch.ts";
import type { SlugMutationLock } from "./platform-lock.ts";
import type { SlotCache } from "./sandbox-slots.ts";
import type { SecretStore } from "./secret-store.ts";
import type { BundleStore } from "./store-types.ts";

/**
 * Bindings every platform route gets. Deliberately holds NOTHING
 * studio-specific: the studio's workspace and chat stores live in
 * `StudioHonoEnv` (aai-studio-server), which extends this. They used to be
 * required here, so the agent service's route context and orchestrator
 * options were coupled to the studio's data model — any studio store change
 * was a compile-time change to aai-server, and the agent-only service
 * constructed Postgres stores it never queried.
 */
export type HonoEnv = {
  Bindings: {
    slots: SlotCache;
    store: BundleStore;
    /** Named secret storage (Supabase Vault in production). */
    secrets: SecretStore;
    /** Per-app database provisioning. Absent when SUPABASE_DB_URL is unset. */
    appDb?: AppDatabases;
    /**
     * Serializes per-slug mutations (deploy/delete/secret/storage). Postgres
     * lease in production so replicas exclude each other; in-process in dev.
     */
    slugLock: SlugMutationLock;
    /**
     * Cross-replica invalidation epochs: mutations bump, session starts
     * compare (see platform-epoch.ts). Postgres in production, memory in dev.
     */
    slugEpochs: SlugEpochs;
  };
  Variables: {
    slug: string;
    apiKey: string;
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
