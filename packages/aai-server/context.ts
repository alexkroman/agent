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
import type { AnalyticsStore } from "./analytics-store.ts";
import type { ApiKeyVerifier } from "./api-key-verify.ts";
import type { AppDatabases } from "./app-database.ts";
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
    /** Per-app database provisioning. Absent when SUPABASE_DB_URL is unset. */
    appDb?: AppDatabases;
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
    /**
     * Session analytics for deployed agents. Absent means the feature is off
     * for this deployment: guests are told no ingest endpoint, the ingest
     * route 404s, and the studio's Analytics pane reports it as unavailable
     * rather than as an agent with no traffic.
     */
    analytics?: AnalyticsBinding;
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

/**
 * The analytics feature's two halves: where rows go, and the secret that mints
 * the per-slug ingest tokens guests present (analytics-token.ts).
 *
 * The secret is OPTIONAL because the two halves have different audiences. The
 * agent service ingests and so needs both; the studio service only ever reads
 * (the pane and `query_analytics`), and handing a read-only surface the
 * credential that authorizes writes is coupling that only widens. A binding
 * without it makes `POST /analytics/ingest` answer "not enabled", which is
 * already what that route says when the feature is off.
 */
export type AnalyticsBinding = {
  store: AnalyticsStore;
  ingestSecret?: string;
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
