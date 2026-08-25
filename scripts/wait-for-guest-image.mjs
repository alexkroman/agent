#!/usr/bin/env node
// Copyright 2026 the AAI authors. MIT license.

/**
 * Wait until THIS checkout's guest image is readable from the registry, so a
 * deploy cannot ship a server that cannot spawn a sandbox.
 *
 * Same failure and the same remedy as `wait-for-npm-versions.mjs` beside it, one
 * layer out. When `GUEST_IMAGE_REGISTRY` is set, every guest spawn resolves
 * `<registry>/aai-guest-harness:<sha16>` (`guest-image-source.ts`), and that tag
 * is published by `.github/workflows/guest-image.yml` — a SEPARATE workflow that
 * triggers on the same push. GitHub Actions cannot `needs:` across workflows, so
 * nothing orders the two, and a deploy that wins the race ships a server asking
 * for an image that does not exist yet.
 *
 * The blast radius is narrower than the npm race but the same shape: the image
 * is pulled at SPAWN time, not deploy time, so the deploy succeeds and every
 * agent session and studio session inside the window fails to pull instead.
 *
 * ## It waits rather than failing fast
 *
 * The image does arrive — the publish takes a few minutes. Failing immediately
 * would be safe (production keeps serving the previous deploy) and needlessly
 * manual, which is the argument the npm waiter already makes.
 *
 * ## A missing image at the deadline is a REAL failure
 *
 * The tag hashes the harness BUNDLE, so this also catches the one thing nothing
 * else can: the publish workflow's harness build and this one producing
 * different bytes. That would mean the tag a spawn asks for is never published
 * by anyone, and no amount of waiting fixes it — so the deadline error names
 * that possibility rather than just reporting a timeout.
 *
 * ## A no-op unless the registry path is actually in use
 *
 * `GUEST_IMAGE_REGISTRY` unset means production builds its own Modal snapshot
 * image and there is nothing to wait for. Skipping loudly, because a silent skip
 * in a gate is indistinguishable from a gate that passed.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
// `scheduler.wait`, matching `wait-for-npm-versions.mjs` beside it.
import { scheduler } from "node:timers/promises";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** How long the image is waited for before the run fails. */
const DEADLINE_MS = 15 * 60_000;

/** Gap between polls. The publish takes minutes, so this need not be tight. */
const POLL_MS = 15_000;

/**
 * The tag this checkout's spawns will ask for, computed by the TypeScript that
 * owns the hash — never reimplemented here. Same delegation, and the same
 * reason, as `build-guest-image.mjs`.
 */
function expectedRef(registry) {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    ["scripts/build-guest-image.mjs", "--print-tag", "--registry", registry],
    { cwd: REPO_ROOT, encoding: "utf-8" },
  );
  if (status !== 0 || !stdout.trim()) {
    throw new Error(`could not compute the guest image tag: ${stderr.trim() || `exit ${status}`}`);
  }
  return stdout.trim();
}

/**
 * Is the manifest readable ANONYMOUSLY?
 *
 * Anonymous on purpose: that is how Modal pulls it, and a token would make this
 * pass for an image Modal cannot read — the exact difference between a public
 * and a private package, which is the one manual step this whole path has.
 */
async function manifestExists(ref) {
  const [registry, ...rest] = ref.split("/");
  const withTag = rest.join("/");
  const at = withTag.lastIndexOf(":");
  const repo = withTag.slice(0, at);
  const tag = withTag.slice(at + 1);
  // GHCR hands out an anonymous pull token per repository.
  const auth = await fetch(
    `https://${registry}/token?service=${registry}&scope=repository:${repo}:pull`,
  ).catch(() => undefined);
  const token = auth?.ok ? ((await auth.json()).token ?? "") : "";
  // Built rather than spread from a truthiness guard (`guard-invariants` rule
  // 22): an absent token means "ask anonymously", which is a different request
  // from one carrying an empty bearer.
  const headers = {
    Accept: "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://${registry}/v2/${repo}/manifests/${tag}`, { headers }).catch(
    () => undefined,
  );
  return res?.status === 200;
}

async function main() {
  const registry = process.env.GUEST_IMAGE_REGISTRY?.trim().replace(/\/+$/, "");
  if (!registry) {
    console.log(
      "wait-for-guest-image: GUEST_IMAGE_REGISTRY is unset — production builds its own " +
        "Modal snapshot image, so there is nothing to wait for.",
    );
    return 0;
  }
  const ref = expectedRef(registry);
  const deadline = Date.now() + DEADLINE_MS;
  console.log(`wait-for-guest-image: waiting for ${ref}`);
  for (;;) {
    if (await manifestExists(ref)) {
      console.log("wait-for-guest-image: readable ✓");
      return 0;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${ref} is still not readable after ${DEADLINE_MS / 60_000} minutes.\n` +
          "Either the Guest image workflow has not published it (check that run), or it " +
          "published a DIFFERENT tag — the tag hashes the harness bundle, so two builds of " +
          "the same commit disagreeing means no spawn will ever find this image. The GHCR " +
          "package must also be PUBLIC: this check is anonymous because Modal's pull is.",
      );
    }
    await scheduler.wait(POLL_MS);
  }
}

try {
  process.exit(await main());
} catch (err) {
  console.error(`wait-for-guest-image: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
