// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * The npm trusted publisher pins a FILENAME, and nothing in a diff says so.
 *
 * The four published packages have no human publisher: every version on the
 * registry carries `_npmUser: GitHub Actions <npm-oidc-no-reply@github.com>`
 * and a `trustedPublisher` of `github`. That configuration lives on npmjs.com,
 * names a repository plus a WORKFLOW FILENAME, and npm checks the filename in
 * the OIDC token against it before minting a publish token.
 *
 * So the name of the file that runs `changeset publish` is part of the release
 * credentials, and renaming it revokes them. Silently: the exchange fails, npm
 * falls back to `NODE_AUTH_TOKEN`, and the registry answers a masked 403 —
 *
 *     E404: Not Found - PUT https://registry.npmjs.org/@alexkroman1%2faai
 *
 * — which reads as "no such package" for a package with 126 versions on it.
 * That is run 33416507871: `release.yml` became `ship.yml` when the release
 * line was consolidated, npm was still configured for `release.yml`, and 9.0.1
 * was built, packed, uploaded and then rejected. The rename is invisible to
 * every other gate here, because the workflow it produced is perfectly valid.
 *
 * Two facts are asserted, and both are things a reviewer cannot see: WHICH file
 * publishes, and which OIDC claims that file will present. Change either and
 * the same change is owed on npmjs.com, for all four packages, before the next
 * version can ship.
 */

import { describe, expect, test } from "vitest";
import { repoPathOf } from "./_gate-support.ts";

/**
 * The workflow filename configured as the trusted publisher on npmjs.com, for
 * `@alexkroman1/aai`, `/aai-cli`, `/aai-ui` and `/aai-runtime`.
 *
 * Written out rather than derived: the point is to hold the repo to a value
 * that lives somewhere this test cannot read, so a value read from the tree
 * would agree with itself and check nothing.
 */
const TRUSTED_PUBLISHER_WORKFLOW = ".github/workflows/ship.yml";

const workflows = import.meta.glob<string>("../../.github/workflows/*.yml", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The step that uploads to npm, as opposed to the prose about it. */
const PUBLISHES = /^\s*run: pnpm exec changeset publish/m;

describe("the publishing workflow is the one npm trusts", () => {
  test("exactly one workflow publishes to npm, at the configured filename", () => {
    // A corpus floor for the same reason every scanning gate here carries one:
    // a glob that stopped resolving would find no publisher, and "no workflow
    // publishes to npm" must fail rather than read as nothing to check.
    expect(Object.keys(workflows).length).toBeGreaterThan(3);
    const publishers = Object.entries(workflows)
      .filter(([, source]) => PUBLISHES.test(source))
      .map(([key]) => repoPathOf(key));
    // A SECOND publishing workflow is the same failure by another route: only
    // one filename is configured, so the other one cannot publish.
    expect(
      publishers,
      `npm's trusted publisher names ${TRUSTED_PUBLISHER_WORKFLOW}. Renaming or ` +
        "moving the publishing workflow revokes the release credentials — update " +
        "the trusted publisher for all four published packages on npmjs.com first.",
    ).toEqual([TRUSTED_PUBLISHER_WORKFLOW]);
  });

  test("the publishing job can request an OIDC token", () => {
    const source = workflows[`../../${TRUSTED_PUBLISHER_WORKFLOW}`];
    expect(source).toBeTypeOf("string");
    // Without `id-token: write` the runner exposes no
    // ACTIONS_ID_TOKEN_REQUEST_URL, npm skips the exchange entirely, and the
    // publish takes the same rejected token fallback as a filename mismatch.
    expect(source).toContain("id-token: write");
  });

  test("the release job claims no environment", () => {
    const source = workflows[`../../${TRUSTED_PUBLISHER_WORKFLOW}`] ?? "";
    const release = source.slice(
      source.indexOf("\n  release:\n"),
      source.indexOf("\n  guest-image:"),
    );
    expect(release).toContain("changeset publish");
    // An `environment:` here would add an `environment` claim to the OIDC
    // token. npm's config for these packages names none, so the exchange would
    // start failing on a line that looks like ordinary hardening — the deploy
    // jobs below carry `environment: production` and are not publishing.
    expect(
      release,
      "adding an environment to the release job changes its OIDC claims; npm's " +
        "trusted publisher must name the same environment or the exchange fails",
    ).not.toMatch(/^ {4}environment:/m);
  });
});
