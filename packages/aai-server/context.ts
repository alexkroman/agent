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
import type { AppDatabases } from "./app-database.ts";
import type { ChatStore } from "./chat-store.ts";
import type { SlugEpochs } from "./platform-epoch.ts";
import type { SlugMutationLock } from "./platform-lock.ts";
import type { SlotCache } from "./sandbox-slots.ts";
import type { SecretStore } from "./secret-store.ts";
import type { BundleStore } from "./store-types.ts";
import type { WorkspaceStore } from "./workspace-store.ts";

export type HonoEnv = {
  Bindings: {
    slots: SlotCache;
    store: BundleStore;
    /** Studio project workspaces (Postgres in production, memory in dev/tests). */
    workspaces: WorkspaceStore;
    /** Studio project chat histories (Postgres in production, memory in dev/tests). */
    chats: ChatStore;
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
    defaultVector: (slug: string) => Vector;
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
