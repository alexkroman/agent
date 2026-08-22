// Copyright 2026 the AAI authors. MIT license.
/**
 * Wait until every publishable package's CURRENT version is READABLE from npm,
 * so a deploy cannot ship a server whose guest image build 404s.
 *
 * The guest snapshot image installs the four SDK packages from npm at the exact
 * versions the checkout declares (`resolveSdkSpecs` in
 * `packages/aai-server/modal-harness-image.ts` — they cannot be lockfile-pinned,
 * because an integrity hash only exists once a version is published). Deploy and
 * Release both trigger on a push to `main`, IN PARALLEL, so the deploy regularly
 * reaches Modal before the release has published: `npm install
 * @alexkroman1/aai@<version>` 404s, the image build fails, and no agent and no
 * studio session can spawn.
 *
 * `deploy.yml` used to answer that with a one-shot check that FAILED in the
 * window. Safe — prod keeps serving the previous version, which works — and
 * needlessly manual, because the versions do arrive, usually a couple of minutes
 * later, and every deploy that landed in the window then needed a human to
 * re-run the job. So it WAITS, and fails only once the versions are still absent
 * at the deadline. That case is the one that really does need a human: a release
 * that errored, or the documented one where `changesets/action` takes the
 * version path and never publishes at all (see `release.yml`'s
 * `workflow_dispatch`).
 *
 * WHAT "readable" MEANS is the other half of this, and it is not "the registry
 * knows the version":
 *
 *   1. **The abbreviated packument lists it.** That document
 *      (`application/vnd.npm.install-v1+json`) is what an `npm install` resolves
 *      against, and it is a separately-cached view from the version-specific
 *      document — so a 200 on `/<pkg>/<version>` does not mean an installer can
 *      find the version yet. Resolving the way the installer resolves is the
 *      whole point of waiting.
 *   2. **Its tarball answers.** That is the byte stream the install then fetches,
 *      from a different cache path again, and it is the request that actually
 *      fails inside the image build.
 *
 * Both are read WITHOUT a cache-buster, deliberately: the question is not
 * whether the registry holds the version, it is whether the view an installer
 * gets holds it. Bypassing the cache would answer a question nobody asked and
 * declare the wait over while the guest image build still 404s.
 *
 * And `npm view` is used for none of it, for the reason `deploy.yml` recorded
 * when this was a one-shot check: this repo installs safe-chain, whose
 * minimum-release-age wrapper reports a just-published version as ABSENT —
 * which would fail every deploy in exactly the window the wait exists to cover.
 *
 * CLI, and the Deploy job's only caller:
 *   node scripts/wait-for-npm-versions.mjs [--timeout-seconds N] [--interval-seconds N]
 *
 * Its spec is `packages/aai-templates/npm-wait-gate.test.ts`, which is also what
 * makes this file reachable to knip — no `entry` line in `knip.json`, because
 * knip follows the spec's `import.meta.glob` and reports one as redundant. Every
 * exported function here exists to be driven from there: nothing above the CLI
 * guard at the bottom touches the network, the clock or `process.exit` on
 * import.
 */

import { join } from "node:path";
import { scheduler } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { publishablePackages, readJson, repoRoot } from "./_fs.mjs";

const REGISTRY = "https://registry.npmjs.org";

/** The media type `npm install` itself asks for — see the module doc. */
const INSTALL_ACCEPT = "application/vnd.npm.install-v1+json";

/**
 * Long enough to cover a whole Release run (install, build, `changeset
 * publish`, and the registry's own propagation) from a cold start, since Deploy
 * and Release begin at the same instant. Measured Release runs land around six
 * minutes; the margin is for the day npm is slow, because the cost of waiting
 * too long is one idle runner and the cost of waiting too little is a manual
 * re-run of the deploy.
 */
const DEFAULT_TIMEOUT_SECONDS = 25 * 60;

/**
 * A fixed interval rather than a backoff: the wait is bounded and the thing it
 * polls is cheap, so the only property that matters is how quickly it notices
 * the publish it is waiting for.
 */
const DEFAULT_INTERVAL_SECONDS = 15;

/**
 * The floor under the derived package list.
 *
 * This gate's success output is "everything is readable", which an empty list
 * satisfies — so a `packages/*` scan that stopped matching would print a
 * checkmark and let the deploy through, the exact failure the wait exists to
 * prevent. Three is what the repo publishes (`@alexkroman1/aai`, `-cli`, `-ui`),
 * and they are also exactly `SDK_PACKAGES` in `modal-harness-image.ts`.
 */
const MIN_PACKAGES = 4;

/**
 * The `name@version` pairs to wait for, DERIVED from the tree.
 *
 * Derived rather than listed because a hand-kept copy of the published set is
 * what goes stale, and this one would go stale silently in a workflow no pull
 * request runs. A package that becomes publishable therefore joins the wait on
 * its own, which is the conservative direction: waiting for a version the guest
 * image does not install costs nothing (its version is already on npm, so the
 * first poll answers), where missing one costs a broken rollout.
 *
 * @param {string} root - repository root
 * @returns {{ name: string, version: string }[]}
 */
export function publishedSpecs(root) {
  return specsFrom(root, publishablePackages(root));
}

/**
 * The floor and the manifest read, split from the `packages/*` scan so a spec
 * can drive them with a list.
 *
 * The floor is the assertion worth testing and the scan is the part a test
 * cannot make lie: `publishablePackages` answers from the real tree, so nothing
 * in a unit test can hand it an empty `packages/` — and an empty list is exactly
 * the input that makes this gate print a checkmark over nothing.
 *
 * @param {string} root - repository root
 * @param {string[]} dirs - repo-relative package directories
 * @returns {{ name: string, version: string }[]}
 */
export function specsFrom(root, dirs) {
  if (dirs.length < MIN_PACKAGES) {
    throw new Error(
      `only ${dirs.length} publishable package(s) found under packages/ (expected at least ` +
        `${MIN_PACKAGES}) — the scan stopped matching, and an empty wait would report every ` +
        "version readable while checking none",
    );
  }
  return dirs.map((dir) => {
    const manifest = readJson(join(root, dir, "package.json"));
    const { name, version } = /** @type {{ name?: unknown, version?: unknown }} */ (manifest);
    if (typeof name !== "string" || typeof version !== "string") {
      throw new Error(`${dir}/package.json is missing a string name or version`);
    }
    return { name, version };
  });
}

/** @param {{ name: string, version: string }} spec */
export function specText(spec) {
  return `${spec.name}@${spec.version}`;
}

/**
 * Is this exact version readable by an installer right now?
 *
 * Both requests are the ones an `npm install` makes, in the order it makes
 * them — see the module doc for why neither is replaced by the cheaper
 * `/<pkg>/<version>` endpoint.
 *
 * @param {{ name: string, version: string, fetchImpl?: typeof fetch }} args
 * @returns {Promise<{ readable: boolean, detail: string }>}
 */
export async function readVersion({ name, version, fetchImpl = fetch }) {
  let packument;
  try {
    packument = await fetchImpl(`${REGISTRY}/${encodeURIComponent(name)}`, {
      headers: { accept: INSTALL_ACCEPT },
    });
  } catch (err) {
    return { readable: false, detail: `packument unreachable (${err.message})` };
  }
  if (!packument.ok) {
    return { readable: false, detail: `packument HTTP ${packument.status}` };
  }
  let body;
  try {
    body = await packument.json();
  } catch (err) {
    return { readable: false, detail: `packument unparsable (${err.message})` };
  }
  const tarball = body?.versions?.[version]?.dist?.tarball;
  if (typeof tarball !== "string") {
    return { readable: false, detail: "not yet in the install packument" };
  }
  let head;
  try {
    head = await fetchImpl(tarball, { method: "HEAD" });
  } catch (err) {
    return { readable: false, detail: `tarball unreachable (${err.message})` };
  }
  if (!head.ok) {
    return { readable: false, detail: `tarball HTTP ${head.status}` };
  }
  return { readable: true, detail: "readable" };
}

/**
 * Poll until every spec is readable, or the deadline passes.
 *
 * Every collaborator is injectable — the clock included — so the timeout path
 * is testable without a test that waits out a real one. A spec drops out of the
 * polled set the moment it reads, so a slow publish is never re-read on a
 * package that already answered.
 *
 * @param {{
 *   specs: { name: string, version: string }[],
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   now?: () => number,
 *   timeoutMs?: number,
 *   intervalMs?: number,
 *   log?: (line: string) => void,
 * }} args
 * @returns {Promise<{
 *   ok: boolean,
 *   attempts: number,
 *   pending: { name: string, version: string, detail: string }[],
 * }>}
 */
export async function waitForVersions({
  specs,
  fetchImpl = fetch,
  sleep = (ms) => scheduler.wait(ms),
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000,
  intervalMs = DEFAULT_INTERVAL_SECONDS * 1000,
  log = console.log,
}) {
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let waiting = specs.map((spec) => ({ ...spec, detail: "unchecked" }));
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const checked = await Promise.all(
      waiting.map(async (spec) => ({ ...spec, ...(await readVersion({ ...spec, fetchImpl })) })),
    );
    for (const spec of checked.filter((spec) => spec.readable)) {
      log(`  readable  ${specText(spec)}`);
    }
    waiting = checked
      .filter((spec) => !spec.readable)
      .map(({ name, version, detail }) => ({ name, version, detail }));
    if (waiting.length === 0) {
      return { ok: true, attempts, pending: [] };
    }
    const elapsedSeconds = Math.round((now() - startedAt) / 1000);
    for (const spec of waiting) {
      log(`  waiting   ${specText(spec)} — ${spec.detail} (${elapsedSeconds}s elapsed)`);
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      return { ok: false, attempts, pending: waiting };
    }
    await sleep(Math.min(intervalMs, remainingMs));
  }
}

/**
 * @param {string[]} argv
 * @param {string} flag
 * @param {number} fallback
 * @returns {number}
 */
function secondsFlag(argv, flag, fallback) {
  const at = argv.indexOf(flag);
  if (at === -1) return fallback;
  const raw = argv[at + 1];
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} expects a positive number of seconds, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} process exit code
 */
export async function main(argv) {
  const specs = publishedSpecs(repoRoot(import.meta.url));
  const timeoutSeconds = secondsFlag(argv, "--timeout-seconds", DEFAULT_TIMEOUT_SECONDS);
  const intervalSeconds = secondsFlag(argv, "--interval-seconds", DEFAULT_INTERVAL_SECONDS);
  console.log(
    `Waiting up to ${timeoutSeconds}s for ${specs.length} version(s) to be readable from npm:`,
  );
  const result = await waitForVersions({
    specs,
    timeoutMs: timeoutSeconds * 1000,
    intervalMs: intervalSeconds * 1000,
  });
  if (result.ok) {
    console.log(`all ${specs.length} version(s) readable from npm ✓`);
    return 0;
  }
  const pending = result.pending.map((spec) => `${specText(spec)} (${spec.detail})`).join(", ");
  console.error(
    `::error title=Unpublished SDK versions::Still not readable from npm after ${timeoutSeconds}s: ` +
      `${pending} — the guest image build would 404 on every sandbox spawn. Publish first ` +
      "(Release workflow, or its workflow_dispatch publish), then re-run this job.",
  );
  return 1;
}

// CLI entry.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
