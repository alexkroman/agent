// Copyright 2026 the AAI authors. MIT license.
/**
 * HTTP handlers for per-app database storage ("storage").
 *
 * Enabling storage provisions a dedicated Postgres schema + role in the
 * platform's Supabase database (see app-database.ts) and stores the
 * credentials in the SecretStore under `app-db:<slug>`. Disabling drops the
 * schema (with all its data) and the role.
 *
 * **A change that really happened BUMPS the agents row, so the running guest
 * is rebuilt.** `DATABASE_URL` is composed when a sandbox is BUILT
 * (`sandbox-resolve.ts`) and the version is the cross-replica invalidation
 * signal (`sandbox-invalidate.ts`), so without the bump enabling a database
 * reached the agent on whatever deploy happened NEXT — and the studio's own
 * post-deploy hook made that gap permanent for the common case: a Publish
 * bumps the row, `handoverSlot` boots the replacement immediately, and
 * `reconcileProjectDatabase` provisions AFTER the deploy returns. So the very
 * first publish after switching the database on produced a production sandbox
 * with no `DATABASE_URL`, which then stayed that way — `ctx.db` throwing, and
 * a workflow upload refusing with "Workflow uploads need a database", on an
 * app whose Database pane says it has one.
 *
 * This is narrower than "storage changes move sandboxes": only a call that
 * CHANGED the state bumps (an already-enabled app is left alone below, which
 * is also what keeps a re-enable from rotating a live credential), and a
 * SECRET change still takes effect on the next deploy by design — the guest
 * re-reads no env of its own, but a secret is not a resource whose absence
 * makes the app half-configured the way a missing database is.
 *
 * Owner-authenticated exactly like the secret routes, which serve
 * `aai storage enable`. The studio's Settings pane switches a database on per
 * PROJECT rather than per slug — a project is two deployed agents (production
 * and preview) — so it calls the CORE functions below directly through
 * aai-studio-server/studio-database.ts; the Hono handlers stay the CLI's
 * per-slug surface.
 */

import { errorMessage } from "@alexkroman1/aai";
import { isRecord } from "@alexkroman1/aai/utils";
import { HTTPException } from "hono/http-exception";
import {
  type AppDatabases,
  type AppDbMeta,
  type AppDbUsage,
  parseAppDbMeta,
  reconcileSessionGrants,
} from "./app-database.ts";
import {
  type AppTable,
  type AppTablePage,
  listAppTables,
  type ReadAppTableParams,
  readAppTable,
} from "./app-db-browse.ts";
import { type AppDbTier, DEFAULT_APP_DB_TIER } from "./app-db-tier.ts";
import type { AppContext } from "./context.ts";
import { createLogger } from "./logger.ts";
import type { SlugMutationLock } from "./platform-lock.ts";
import { appDbSecretName, type SecretStore, type SqlExec } from "./secret-store.ts";
import type { BundleStore } from "./store-types.ts";

const log = createLogger("storage");

/** What the storage core needs from the server bindings. */
export type StorageEnv = {
  secrets: SecretStore;
  appDb?: AppDatabases | undefined;
  slugLock: SlugMutationLock;
  /**
   * Agents rows — bumped so a resident guest picks the change up (see the
   * module doc). Optional because several specs drive the core with neither a
   * store nor a sandbox behind it; a missing one is reported, never silent.
   */
  store?: BundleStore | undefined;
};

const UNCONFIGURED_MESSAGE =
  "Storage is not configured on this server (SUPABASE_DB_URL is not set)";

/** Is storage enabled (credentials provisioned) for this app? */
export async function storageStatus(env: StorageEnv, slug: string): Promise<{ enabled: boolean }> {
  const meta = await env.secrets.get(appDbSecretName(slug));
  return { enabled: meta !== null };
}

/**
 * What the app's database holds — tables, rows, bytes — or null when it has
 * none, when this server cannot provision at all, or when the read failed.
 *
 * **A failed read is `null`, never a thrown request.** This is an observation
 * about a tenant schema on a shared cluster, offered beside a switch whose
 * own state is already known; a cluster hiccup must degrade the number, not
 * the pane that reports whether the database is on.
 */
export async function storageUsage(env: StorageEnv, slug: string): Promise<AppDbUsage | null> {
  const appDb = env.appDb;
  if (!appDb) return null;
  const meta = parseAppDbMeta(await env.secrets.get(appDbSecretName(slug)));
  if (!meta) return null;
  // `usage` rather than `withAppDatabase` below: it opens the connection on the
  // cluster the META locates, which is the same rule `deprovision` states — a
  // recomputed placement points at a cluster that never hosted this app.
  return appDb.usage(slug, meta).catch((err: unknown) => {
    log.warn("app database usage read failed", { slug, error: errorMessage(err) });
    return null;
  });
}

/**
 * Run `fn` on a connection into one app's database, or answer `null` when
 * there is no database to open (storage off, or this server cannot provision).
 *
 * The one place the `app-db:<slug>` secret is turned into a live executor for
 * an arbitrary READ: is there an `appDb`, is there a stored meta, open, close —
 * and the last is the one a caller forgets. `withAppDb` locates the cluster
 * from the meta, which is the placement rule `deprovision` documents.
 */
async function withAppDatabase<T>(
  env: StorageEnv,
  slug: string,
  fn: (sql: SqlExec) => Promise<T>,
): Promise<T | null> {
  const appDb = env.appDb;
  if (!appDb) return null;
  const meta = parseAppDbMeta(await env.secrets.get(appDbSecretName(slug)));
  if (!meta) return null;
  return appDb.withAppDb(meta, fn);
}

/**
 * The app's tables, or `null` when it has no database.
 *
 * A failed read THROWS here, unlike {@link storageUsage}, and the difference is
 * what the caller is showing. Usage is a number offered beside a switch whose
 * own state is already known, so a cluster hiccup must degrade the number
 * rather than the pane. This IS the pane: an empty table list that really means
 * "the read failed" tells the author their agent has stored nothing, which is
 * the one answer a viewer must never invent.
 */
export function storageTables(env: StorageEnv, slug: string): Promise<AppTable[] | null> {
  return withAppDatabase(env, slug, listAppTables);
}

/** One page of one of the app's tables, or `null` with no database to read. */
export function storageTableRows(
  env: StorageEnv,
  slug: string,
  params: ReadAppTableParams,
): Promise<AppTablePage | null> {
  return withAppDatabase(env, slug, (sql) => readAppTable(sql, params));
}

/**
 * Provision + persist credentials. Idempotent, and idempotent is the POINT
 * rather than a nicety.
 *
 * **An already-enabled app is left alone.** `provision` mints a fresh password
 * on every call and the caller persists it, so re-provisioning ROTATES the
 * role's credentials — while the resident guest is still holding the
 * `DATABASE_URL` baked into it at spawn. `aai storage enable` run twice was
 * enough: the second call stopped the running agent's `ctx.db` from
 * authenticating, mid-session, with nothing on this side reporting anything.
 * (Secret and storage changes deliberately do not move sandboxes — see "Deploy
 * and delete are the ONLY mutations that move sandboxes" in this package's
 * guide — so there is no rebuild behind this to paper over it.)
 *
 * The check is INSIDE the slug lock, so two concurrent enables cannot both see
 * "absent" and both provision. The studio's own per-project path reads
 * `storageStatus` first for the same reason; this is the guard the per-slug
 * route was missing, and having it here means neither caller can forget it.
 */
export function enableStorage(
  env: StorageEnv,
  slug: string,
  tier: AppDbTier = DEFAULT_APP_DB_TIER,
): Promise<{ enabled: true }> {
  const appDb = env.appDb;
  if (!appDb) throw new HTTPException(503, { message: UNCONFIGURED_MESSAGE });
  return env.slugLock(slug, async () => {
    const existing = parseAppDbMeta(await env.secrets.get(appDbSecretName(slug)));
    if (existing) {
      // Already provisioned, so this is a no-op for the CREDENTIAL — but it is
      // the one place an existing app database is touched without rotating it,
      // which makes it the heal for a database provisioned before the session
      // event log became append-only (`reconcileSessionGrants`). Best-effort:
      // enabling storage must not fail because a grant could not be reconciled.
      // `try`, not `.catch`: a stubbed-out or misconfigured opener can throw
      // SYNCHRONOUSLY, which no rejection handler on the returned promise sees.
      try {
        await appDb.withAppDb(existing, (sql) => reconcileSessionGrants(sql, slug));
      } catch (err) {
        log.warn("session-table grants not reconciled", { slug, error: errorMessage(err) });
      }
      // And it is therefore where a TIER change lands. An app that adds
      // workflows needs the wider entitlement and a re-provision cannot deliver
      // it — that rotates the password out from under the resident guest, which
      // is the failure the whole idempotent branch exists to prevent. `alter
      // role … connection limit` touches neither password nor login, so it can
      // ride here; `aai storage enable` on an app whose config changed is the
      // documented way to apply one.
      await reconcileStoredTier(env, appDb, slug, existing, tier);
      return { enabled: true as const };
    }
    const meta = await appDb.provision(slug, tier);
    await env.secrets.put(appDbSecretName(slug), JSON.stringify(meta));
    log.info("enabled", { slug, role: meta.role, tier });
    await rebuildGuest(env, slug, "enabled");
    return { enabled: true as const };
  });
}

/**
 * Apply `tier` to an app already provisioned at another one, and record it.
 *
 * Two writes, in this order, and the order is what makes a partial failure
 * benign: the ROLE first, then the stored meta. A limit raised whose meta was
 * not updated is an app with more headroom than its record claims — invisible,
 * and repaired by the next enable. The reverse would be a record promising an
 * entitlement the role does not have, which is the `too many connections for
 * role` failure arriving from whichever consumer asked last.
 *
 * Best-effort for the same reason its neighbour above is: the database exists
 * and its credentials are stored, so failing the request here would report
 * "could not enable the database" for a database that works. A guest is rebuilt
 * only when something really changed, matching the module doc's rule.
 */
async function reconcileStoredTier(
  env: StorageEnv,
  appDb: AppDatabases,
  slug: string,
  meta: AppDbMeta,
  tier: AppDbTier,
): Promise<void> {
  const stored = meta.tier ?? DEFAULT_APP_DB_TIER;
  if (stored === tier) return;
  try {
    const { changed } = await appDb.reconcileTier(slug, meta, tier);
    await env.secrets.put(appDbSecretName(slug), JSON.stringify({ ...meta, tier }));
    log.info("tier reconciled", { slug, from: stored, to: tier, changed });
    // The guest's own connection ceiling is a property of the ROLE, so nothing
    // in the guest's env changed — but a guest that has been refused
    // connections at the old limit needs a fresh start to stop having been, and
    // one moving DOWN a tier should not keep pools it is no longer entitled to.
    if (changed) await rebuildGuest(env, slug, `retiered to ${tier}`);
  } catch (err) {
    log.warn("connection tier not reconciled", { slug, error: errorMessage(err) });
  }
}

/** Deprovision (drops the schema and its data) + delete credentials. */
export function disableStorage(env: StorageEnv, slug: string): Promise<{ enabled: false }> {
  const appDb = env.appDb;
  if (!appDb) throw new HTTPException(503, { message: UNCONFIGURED_MESSAGE });
  return env.slugLock(slug, async () => {
    // Read the locator BEFORE deleting the secret that holds it: the stored
    // `url` names the cluster this app lives on, and recomputing that
    // placement drops on the wrong one after any change to APP_DB_URLS (see
    // AppDatabases.deprovision).
    const meta = parseAppDbMeta(await env.secrets.get(appDbSecretName(slug)));
    await appDb.deprovision(slug, meta);
    await env.secrets.delete(appDbSecretName(slug));
    log.info("disabled", { slug });
    // Both directions: a guest still holding a `DATABASE_URL` to a schema that
    // has been dropped fails every `ctx.db` call at the DRIVER, which is a
    // worse report than the enablement error a rebuilt one gives.
    await rebuildGuest(env, slug, "disabled");
    return { enabled: false as const };
  });
}

/**
 * Bump the agents row so this slug's resident sandbox is rebuilt with the
 * environment the change just created (or removed). See the module doc.
 *
 * Reported and swallowed, never thrown: the provisioning has already happened
 * and its credentials are already stored, so failing the request here would
 * report "could not enable the database" for a database that exists — and the
 * change still lands on the next deploy, which is exactly where it landed
 * before this bump existed. A slug with no row (`false`) is the ordinary case
 * for the studio, which switches a project's database on before either agent
 * has deployed.
 */
async function rebuildGuest(env: StorageEnv, slug: string, change: string): Promise<void> {
  if (!env.store) {
    log.warn(`storage ${change} without an agents store: the running agent keeps its old env`, {
      slug,
    });
    return;
  }
  try {
    await env.store.touchAgent(slug);
  } catch (err) {
    log.warn(`storage ${change}: could not bump the agent for a rebuild`, {
      slug,
      error: errorMessage(err),
    });
  }
}

// ── Hono handlers (owner routes: GET/POST/DELETE /:slug/storage) ─────────────

export async function handleStorageStatus(c: AppContext): Promise<Response> {
  return c.json(await storageStatus(c.env, c.var.slug));
}

export async function handleStorageEnable(c: AppContext): Promise<Response> {
  const { enabled } = await enableStorage(c.env, c.var.slug, await requestedTier(c));
  return c.json({ ok: true, enabled });
}

/**
 * The tier a `POST /:slug/storage` asks for, defaulting to
 * {@link DEFAULT_APP_DB_TIER}.
 *
 * **A body is OPTIONAL and an unreadable one is not an error.** This route has
 * taken no body since it existed, so every `aai storage enable` in the wild — and
 * the studio, which calls the core function directly — sends none; a strict parse
 * would turn a working command into a 400 on upgrade. An unrecognised `tier`
 * likewise falls back rather than refusing: the value only ever selects from a
 * closed set, and the default is what every app used to get.
 *
 * The caller is already owner-authenticated, so this is not a trust boundary
 * being widened — see {@link AppDbTier} for why a tenant-supplied tier is safe
 * (the widest tier is the status quo, so asking gains nothing).
 */
async function requestedTier(c: AppContext): Promise<AppDbTier> {
  const body: unknown = await c.req.json().catch(() => undefined);
  const tier = isRecord(body) ? body.tier : undefined;
  return tier === "storage" || tier === "workflow" ? tier : DEFAULT_APP_DB_TIER;
}

export async function handleStorageDisable(c: AppContext): Promise<Response> {
  const { enabled } = await disableStorage(c.env, c.var.slug);
  return c.json({ ok: true, enabled });
}
