// Copyright 2026 the AAI authors. MIT license.
/**
 * Sandbox observability identity: what a guest sandbox is FOR, as Modal tags.
 *
 * Every guest sandbox the platform spawns looks identical from the Modal
 * dashboard — same app, same image, same exec — so the tags minted here are
 * the only way to tell a production voice agent from a studio coding-agent
 * session, a preview deploy, or a throwaway bundle inspection. Tags are
 * filterable in Modal's sandbox list (`client.sandboxes.list`) and visible
 * per sandbox in the dashboard. Every spawn knows its identity at creation
 * (the warm pool, which spawned identityless spares, is gone).
 *
 * Observability ONLY: nothing security-relevant may key off these tags — the
 * Modal container is the boundary, and `roleForSlug`'s preview inference is a
 * suffix heuristic (a user-deployed agent whose slug happens to end in
 * `-preview` is mislabeled, harmlessly).
 */

import { omitUndefined } from "@alexkroman1/aai";
import { PREVIEW_SLUG_SUFFIX } from "@alexkroman1/aai/internal";

/** What a guest sandbox was spawned (or acquired) to do. */
export type SandboxRole =
  /** A deployed agent's production sandbox (voice sessions). */
  | "agent"
  /** A studio project's auto-deployed preview agent (`<project>-preview`). */
  | "preview"
  /** A studio project's coding-agent session sandbox (chat + tools). */
  | "studio"
  /** An ephemeral sandbox spawned for one studio Publish, torn down after. */
  | "studio-publish";

// `PREVIEW_SLUG_SUFFIX` lives in the SDK's slug contract
// (`@alexkroman1/aai/utils`) rather than here: the CLI needs it too — to
// refuse `*-preview` project names — and cannot import this private package.
// Import it from there directly; this module no longer re-exports it.

/** Infer an agent sandbox's role from its slug (preview slugs by suffix). */
export function roleForSlug(slug: string): SandboxRole {
  return slug.endsWith(PREVIEW_SLUG_SUFFIX) ? "preview" : "agent";
}

/** The slug/role pair every spawn path carries (both optional). */
export type SpawnIdentity = {
  slug?: string | undefined;
  role?: SandboxRole | undefined;
  /**
   * Fleet-wide Modal sandbox NAME, when this spawn must be unique across
   * replicas (see sandbox-directory.ts). Modal refuses a duplicate, so two
   * replicas racing to spawn for the same thing cannot both succeed. Omitted
   * by spawns that are legitimately per-caller (an ephemeral Publish).
   */
  name?: string | undefined;
};

/**
 * Resolve the effective role for a spawn: an explicit role wins, else it is
 * inferred from the slug. A spawn carrying neither is a control-channel
 * guest, which is a studio one — the only other roleless spawn was bundle
 * inspection, and the platform no longer inspects bundles.
 */
export function resolveSandboxRole(opts: SpawnIdentity): SandboxRole {
  return opts.role ?? (opts.slug ? roleForSlug(opts.slug) : "studio");
}

/** The tag set attached to every guest sandbox at creation. */
export function sandboxTags(role: SandboxRole, slug?: string): Record<string, string> {
  return { service: "aai-guest", role, ...omitUndefined({ slug }) };
}
