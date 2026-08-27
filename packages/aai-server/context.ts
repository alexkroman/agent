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
import type { ApiKeyVerifier } from "./api-key-verify.ts";
import type { SlugMutationLock } from "./platform-lock.ts";
import type { SecretStore } from "./secret-store.ts";
import type { BundleStore } from "./store-types.ts";
import type { StudioAuth } from "./supabase-auth.ts";

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
    store: BundleStore;
    /** Named secret storage (Supabase Vault in production). */
    secrets: SecretStore;
    /**
     * Serializes per-slug mutations (deploy/delete/secret/storage). Postgres
     * lease in production so replicas exclude each other; in-process in dev.
     */
    slugLock: SlugMutationLock;
    /**
     * Browser-session auth (Supabase in production, dev tokens locally).
     * Absent means raw-API-key bearers only — the CLI's protocol.
     */
    auth?: StudioAuth;
    /**
     * Verifies that a raw API-key bearer is a credential AssemblyAI issued
     * (see api-key-verify.ts). Absent means ANY bearer string is accepted as
     * a key — correct for dev and tests, which is why it is optional, and the
     * reason the production builder returns one unless explicitly told not to.
     */
    keyVerifier?: ApiKeyVerifier;
  };
  Variables: {
    slug: string;
    apiKey: string;
    /**
     * The studio user id when the bearer was a browser session token;
     * absent for raw-API-key callers (CLI, in-guest deploys).
     */
    userId?: string;
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

/** Context for handlers whose route params were pre-validated by `zValidator`. */
export type ValidatedParamContext<T> = Context<
  HonoEnv,
  string,
  { in: { param: T }; out: { param: T } }
>;
