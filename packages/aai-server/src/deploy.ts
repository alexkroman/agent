// Copyright 2025 the AAI authors. MIT license.

import { PREVIEW_SLUG_SUFFIX } from "@alexkroman1/aai/internal";
import type { AgentRecord } from "./agent-store.ts";
import type { ValidatedAppContext } from "./context.ts";
import { createLogger } from "./logger.ts";
import { localSlugLock, type SlugMutationLock } from "./platform-lock.ts";
import type { DeployBody } from "./schemas.ts";
import { EnvSchema, RESERVED_SLUGS } from "./schemas.ts";
import { hashApiKey, matchAnyHash } from "./secrets.ts";
import { generatedSlug } from "./slug-generate.ts";
import type { BundleStore } from "./store-types.ts";

const log = createLogger("agent.deploy");

/** Server-level dependencies the deploy core needs (a subset of Bindings). */
export type DeployDeps = {
  store: BundleStore;
  /**
   * Per-slug mutation lock. Cross-replica (Postgres lease) in production;
   * defaults to the in-process lock for tests and single-replica callers.
   */
  slugLock?: SlugMutationLock | undefined;
  /**
   * The harness snapshot image tag new sandboxes currently spawn from —
   * recorded on the agents row so this deploy keeps running on the SAME
   * guest image across platform upgrades (see `currentHarnessImageTag` in
   * sandbox-vm.ts). Absent (tests) or resolving null (subprocess backend)
   * records no pin.
   */
  harnessImageTag?: (() => Promise<string | null>) | undefined;
};

export type DeployParams = {
  /** Requested slug. Omit to generate one (`generatedSlug`). */
  slug?: string | undefined;
  apiKey: string;
  worker: string;
  clientFiles: Record<string, string>;
  env?: Record<string, string> | undefined;
  /**
   * Permit a requested slug ending in {@link PREVIEW_SLUG_SUFFIX}. That suffix
   * is owned by the studio's auto-preview deploys, and the orphan-preview
   * pg_cron sweep (pg-cron.ts) reaps any `*-preview` agent no studio workspace
   * references — dropping its Vault secrets and its agents row, hourly. A CLI caller that lands on the suffix by accident
   * would therefore lose the agent (and any stored data) on a schedule no
   * redeploy can undo. So the suffix is rejected unless the caller opts in;
   * the studio's in-guest `aai deploy` sets this, nothing else should.
   */
  allowPreviewSlug?: boolean | undefined;
};

export type DeployOutcome =
  | { ok: true; slug: string; message: string }
  | { ok: false; status: 400 | 403 | 409; error: string };

/**
 * Deploy an agent bundle: claim (or re-claim) the slug under its lock,
 * verify ownership, and persist the bundle. Shared by the HTTP deploy
 * handlers and the browser studio's deploy tool so ownership semantics
 * have a single source of truth.
 */
export function deployAgentBundle(deps: DeployDeps, params: DeployParams): Promise<DeployOutcome> {
  const requested = params.slug;
  // Single choke point for reserved names — programmatic callers (the studio
  // deploy tool) don't pass through DeployBodySchema.
  if (requested && RESERVED_SLUGS.has(requested)) {
    return Promise.resolve({ ok: false as const, status: 400 as const, error: "Reserved slug" });
  }
  // The `-preview` suffix is effectively reserved for the studio's auto-preview
  // deploys (`previewSlugFor`): the orphan-preview sweep reaps any `*-preview`
  // agent no workspace references, so a CLI caller landing on it loses the
  // agent on an unrecoverable hourly schedule
  // (see DeployParams.allowPreviewSlug). Only the studio's in-guest deploy,
  // which passes the opt-in, may claim it. Generated slugs never hit this —
  // the generator appends a random suffix — so only a *requested* slug is
  // checked.
  if (requested?.endsWith(PREVIEW_SLUG_SUFFIX) && !params.allowPreviewSlug) {
    return Promise.resolve({
      ok: false as const,
      status: 400 as const,
      error: `The "${PREVIEW_SLUG_SUFFIX}" suffix is reserved for studio previews`,
    });
  }
  // No requested slug: the generator mints one from human-id words plus a
  // random suffix. It takes no readable base, because the platform knows
  // nothing about the bundle to derive one from — see "The platform stores
  // no agent config" in CLAUDE.md. A caller that wants its name in the URL
  // requests the slug.
  const slug = requested ?? generatedSlug();
  const lock = deps.slugLock ?? localSlugLock;
  return lock(slug, async () => {
    // Ownership is checked whether the slug was requested or generated. A
    // generated slug used to skip this entirely, so a generated-name
    // collision with an existing agent would overwrite that agent's bundle
    // and append the caller's credential hash to it — silently granting a
    // stranger co-ownership. The random suffix makes collisions negligible
    // but not impossible, and the check costs one row read either way.
    const existing = await deps.store.getAgent(slug);
    const matchedHash = existing ? matchAnyHash(params.apiKey, existing.credential_hashes) : null;
    if (existing && matchedHash === null) {
      return requested
        ? { ok: false, status: 403, error: "Forbidden: slug already owned by another user" }
        : // The caller never chose this slug, so "forbidden" would be
          // confusing — tell them to retry and get a fresh one.
          { ok: false, status: 409, error: "Slug collision on generated name — retry the deploy" };
    }
    const keyHash = matchedHash ?? hashApiKey(params.apiKey);
    // The check above and deployLocked run under the same slug lock, so the
    // record snapshot and match result can be passed through — no TOCTOU,
    // no second read.
    return deployLocked(deps, params, { slug, existing, matchedHash, keyHash });
  });
}

/** Persist the bundle for a slug the caller is entitled to. Runs under the slug lock. */
async function deployLocked(
  deps: DeployDeps,
  params: DeployParams,
  ctx: {
    slug: string;
    /** Agent-record snapshot read under the slug lock in `deployAgentBundle`. */
    existing: AgentRecord | null;
    /** Stored hash `apiKey` matched, or null when the slug was unclaimed. */
    matchedHash: string | null;
    keyHash: string;
  },
): Promise<DeployOutcome> {
  const { slug, existing, matchedHash, keyHash } = ctx;

  // The env floor (seeding a caller's own key where nothing else supplies it)
  // is the CLI's job now — `aai deploy` merges it into `env` client-side, and
  // studio Publish runs that same CLI in-guest. The server-side `defaultEnv`
  // that used to do it had no caller left.
  const storedEnv = existing ? ((await deps.store.getEnv(slug)) ?? {}) : {};
  const env = { ...storedEnv, ...params.env };

  const envParsed = EnvSchema.safeParse(env);
  if (!envParsed.success) {
    return { ok: false, status: 400, error: `Invalid platform config: ${envParsed.error.message}` };
  }

  // Preserve multi-user ownership: append the deployer's hash only when no
  // stored hash already matches their key.
  const existingHashes = existing?.credential_hashes ?? [];
  const alreadyStored = matchedHash !== null || existingHashes.includes(keyHash);
  const mergedHashes = alreadyStored ? existingHashes : [...existingHashes, keyHash];

  // Best-effort pin: a failed tag computation must not fail the deploy —
  // the agent just runs unpinned (the pre-pinning behavior).
  const harnessImageTag = (await deps.harnessImageTag?.().catch(() => null)) ?? null;

  await deps.store.putAgent({
    slug,
    env,
    worker: params.worker,
    clientFiles: params.clientFiles,
    credential_hashes: mergedHashes,
    harnessImageTag,
  });

  // The row upsert IS the invalidation: it bumps the deploy version, and the
  // agents row's change stream retires every replica's superseded resident —
  // this one's included (see watchAgentInvalidation in sandbox-resolve.ts).
  // No local slot surgery here: mutation handlers write rows, the change
  // stream moves sandboxes.

  log.debug("Deploy received", { slug });

  return { ok: true, slug, message: `Deployed ${slug}` };
}

// ── HTTP handlers ────────────────────────────────────────────────────────────

function outcomeToResponse(c: ValidatedAppContext<DeployBody>, outcome: DeployOutcome): Response {
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
  return c.json({ ok: true, slug: outcome.slug, message: outcome.message });
}

/**
 * `POST /deploy` — deploy to the body's slug, or a server-generated one.
 *
 * The platform learns NOTHING about the bundle: it stores the artifacts and
 * the ownership hashes, and the bundle describes itself to its own SDK
 * inside its own sandbox. See "The platform stores no agent config" in
 * CLAUDE.md for what that replaced and why the guest-side extraction went
 * away with it.
 */
export async function handleDeployNew(
  c: ValidatedAppContext<DeployBody>,
  harnessImageTag?: () => Promise<string | null>,
): Promise<Response> {
  const deps = {
    store: c.env.store,
    slugLock: c.env.slugLock,
    harnessImageTag,
  };
  const body = c.req.valid("json");
  const outcome = await deployAgentBundle(deps, {
    slug: body.slug,
    apiKey: c.var.apiKey,
    worker: body.worker,
    clientFiles: body.clientFiles,
    env: body.env,
    allowPreviewSlug: body.allowPreviewSlug,
  });
  return outcomeToResponse(c, outcome);
}
