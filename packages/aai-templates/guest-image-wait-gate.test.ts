// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * The wiring that stands between a deploy and an image no registry holds.
 *
 * `scripts/wait-for-guest-image.mjs` is the sibling of `wait-for-npm-versions.mjs`
 * one layer out, and `npm-wait-gate.test.ts` beside this file argues the shape:
 * Deploy runs on no pull request, so nothing reads this wiring before production
 * does. What that spec does NOT cover is the way this particular waiter fails,
 * which is not a poll loop or a packument shape — it is being ARMED.
 *
 * The waiter no-ops, loudly, when `GUEST_IMAGE_REGISTRY` is unset, on the sound
 * reasoning that production then builds its own Modal snapshot image and there
 * is nothing to wait for. But production does not read that variable from this
 * repository: it reads it from the Modal secret `aai-server`, which CI cannot
 * see. So for as long as the step declared no env, the gate asked "is the
 * registry path in use?" of a different environment than the one that answers it
 * at spawn time, and returned 0 on every deploy.
 *
 * What that cost, on 2026-08-31: `scripts/build-guest-image.mjs` lost the
 * `read` import in a refactor that moved the helper to a sibling module, so
 * `resolveSdkSpecs` threw `read is not defined` and the Guest image workflow
 * failed three runs in a row. Three deploys shipped green over an image nobody
 * had pushed. Every studio session and every cold agent spawn then died on
 * `manifest unknown` — which Modal reports as `Image build for im-<id> failed
 * with the exception:` followed by NOTHING, so the one line an operator got
 * named no tag, no registry and no remedy.
 *
 * Both halves are asserted here because either alone is a gate that passes over
 * the failure: a step that runs an unarmed waiter, and an armed waiter pointed
 * at a registry nothing publishes to.
 *
 * It lives in aai-templates because this package already owns the tests for
 * repo-level scripts and workflow wiring.
 */

import { describe, expect, test } from "vitest";
import { sole } from "./_gate-support.ts";

const deployWorkflow = sole(
  import.meta.glob<string>("../../.github/workflows/deploy.yml", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

const guestImageWorkflow = sole(
  import.meta.glob<string>("../../.github/workflows/guest-image.yml", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

const waitScript = sole(
  import.meta.glob<string>("../../scripts/wait-for-guest-image.mjs", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

/**
 * The registry each workflow names, read out of the YAML.
 *
 * COMPARED rather than matched against a constant here, which is both the
 * stronger assertion — it proves the two agree, where a hardcoded expression only
 * proves each matches this file — and the way out of a lint standoff:
 * `noTemplateCurlyInString` rejects an Actions `${{ … }}` inside a plain string
 * while `noUnusedTemplateLiteral` rejects the escaped template literal that fixes
 * it, and a lint suppression is worse than either — the escape-hatch ratchet
 * counts those, and it counts a mention in PROSE too, which is why this
 * paragraph does not spell the directive it is declining to use.
 *
 * The OWNER, not the repo: the tag already carries the image name, and
 * `guestImageRef` joins the two with one slash.
 */
function registryValue(yaml: string | undefined, key: string): string | undefined {
  return new RegExp(`${key}:[ \\t]*(\\S.*)$`, "m").exec(yaml ?? "")?.[1]?.trim();
}

describe("the deploy job waits for the guest image", () => {
  test("every source resolved", () => {
    // A glob that stopped resolving would make every assertion below vacuous.
    for (const source of [deployWorkflow, guestImageWorkflow, waitScript]) {
      expect(typeof source).toBe("string");
      expect((source ?? "").length).toBeGreaterThan(200);
    }
  });

  test("it runs the waiter, after node is set up and before the deploy", () => {
    const waitAt = deployWorkflow?.indexOf("node scripts/wait-for-guest-image.mjs") ?? -1;
    expect(waitAt).toBeGreaterThan(-1);
    expect(waitAt).toBeGreaterThan(deployWorkflow?.indexOf("actions/setup-node@") ?? -1);
    expect(waitAt).toBeLessThan(deployWorkflow?.indexOf("modal deploy") ?? -1);
  });

  test("and DECLARES the registry, so the waiter is armed rather than skipping", () => {
    // The regression this file exists for. Without an env the script returns 0
    // on every deploy, and the failure it exists to catch ships green.
    const step = deployWorkflow?.slice(
      deployWorkflow.indexOf("Wait for the guest image"),
      deployWorkflow.indexOf("node scripts/wait-for-guest-image.mjs"),
    );
    expect(step).toContain("GUEST_IMAGE_REGISTRY:");
    // A value, not just the key: an empty one skips exactly as an absent one does.
    expect(registryValue(step, "GUEST_IMAGE_REGISTRY")).toMatch(/ghcr\.io/);
  });

  test("naming the SAME registry the publish step pushes to", () => {
    // Two different owners would wait forever on an image that exists.
    const waited = registryValue(deployWorkflow, "GUEST_IMAGE_REGISTRY");
    const published = registryValue(guestImageWorkflow, "REGISTRY");
    expect(waited).toBe(published);
    // And it is DERIVED from the repository, not a pasted owner that goes stale
    // on a fork or a transfer.
    expect(waited).toContain("github.repository_owner");
  });
});

describe("the waiter's own contract", () => {
  test("an unset registry is a SKIP, which is why the declaration is load-bearing", () => {
    // Asserted rather than assumed: this is the behaviour that turned the step
    // into a no-op, and a future edit making the skip conditional on something
    // else would silently move the gate's meaning again.
    expect(waitScript).toContain("GUEST_IMAGE_REGISTRY is unset");
    expect(waitScript).toMatch(/if \(!registry\)/);
  });

  test("it computes the tag by delegating, never by reimplementing the hash", () => {
    // The tag hashes the harness bundle. A second implementation here would
    // wait for a reference no spawn ever asks for — a gate that always passes,
    // or never does, and cannot be told apart from a broken publisher.
    expect(waitScript).toContain("--print-tag");
    expect(waitScript).not.toContain("createHash");
  });

  test("it asks ANONYMOUSLY, because that is how Modal pulls", () => {
    // A token would make this pass for an image Modal cannot read, which is the
    // exact difference between a public and a private GHCR package — the one
    // manual step this whole path has.
    expect(waitScript).toContain("anonymous");
    expect(waitScript).not.toContain("GITHUB_TOKEN");
  });

  test("a missing image at the deadline FAILS rather than warning through", () => {
    // The publisher being broken and the publisher being slow are the same
    // observation from here, and only the deadline distinguishes them. Reaching
    // it must stop the deploy: production keeps serving the previous one.
    expect(waitScript).toMatch(/throw new Error\(/);
    expect(waitScript).toContain("still not readable");
  });
});
