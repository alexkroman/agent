// Copyright 2026 the AAI authors. MIT license.
/**
 * Sandbox observability identity: what a guest sandbox is FOR, as Modal tags.
 *
 * Every guest sandbox the platform spawns looks identical from the Modal
 * dashboard — same app, same image, same exec — so the tags minted here are
 * the only way to tell a production voice agent from a studio coding-agent
 * session, a preview deploy, a warm-pool spare, or a throwaway bundle
 * inspection. Tags are filterable in Modal's sandbox list
 * (`client.sandboxes.list`) and visible per sandbox in the dashboard.
 *
 * Observability ONLY: nothing security-relevant may key off these tags — the
 * Modal container is the boundary, and `roleForSlug`'s preview inference is a
 * suffix heuristic (a user-deployed agent whose slug happens to end in
 * `-preview` is mislabeled, harmlessly).
 *
 * Pooled sandboxes are created before they have an identity, so they start
 * tagged `role: "pool"` and are RE-tagged via the backend's `setTags` when
 * acquired for a real purpose (see `acquireWarmHarness` / `createSandboxVm`).
 * Without the retag, every warm-pool-served sandbox would read "pool"
 * forever, which is exactly the indistinguishability this module exists to
 * fix.
 */

/** What a guest sandbox was spawned (or acquired) to do. */
export type SandboxRole =
  /** A deployed agent's production sandbox (voice sessions). */
  | "agent"
  /** A studio project's auto-deployed preview agent (`<project>-preview`). */
  | "preview"
  /** A studio project's coding-agent session sandbox (chat + tools). */
  | "studio"
  /** An ephemeral sandbox spawned for one studio Publish, torn down after. */
  | "studio-publish"
  /** A throwaway bundle-inspection sandbox (`describeBundle`). */
  | "inspect"
  /** A warm-pool spare with no identity yet (retagged on acquire). */
  | "pool";

/**
 * Suffix of studio preview slugs (see `previewSlugFor` in
 * aai-studio-server/studio-preview.ts, which imports this so the deploy path
 * and the tag inference can't drift).
 */
export const PREVIEW_SLUG_SUFFIX = "-preview";

/** Infer an agent sandbox's role from its slug (preview slugs by suffix). */
export function roleForSlug(slug: string): SandboxRole {
  return slug.endsWith(PREVIEW_SLUG_SUFFIX) ? "preview" : "agent";
}

/** The slug/role pair every spawn path carries (both optional). */
export type SpawnIdentity = {
  slug?: string | undefined;
  role?: SandboxRole | undefined;
};

/**
 * Resolve the effective role for a spawn: an explicit role wins, else it is
 * inferred from the slug, else the sandbox is an identityless pool spare.
 */
export function resolveSandboxRole(opts: SpawnIdentity): SandboxRole {
  return opts.role ?? (opts.slug ? roleForSlug(opts.slug) : "pool");
}

/** The tag set attached to (and re-applied on) every guest sandbox. */
export function sandboxTags(role: SandboxRole, slug?: string): Record<string, string> {
  return { service: "aai-guest", role, ...(slug ? { slug } : {}) };
}
