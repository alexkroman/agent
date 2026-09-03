// Copyright 2026 the AAI authors. MIT license.
/**
 * A fake GitHub, and a real key to sign against it.
 *
 * The GitHub half of this feature is reached ONLY through Octokit, so the
 * honest seam is the `fetch` Octokit is constructed with (`GithubClientOptions
 * .fetchFn`) — not a module mock over our own wrappers. That difference is
 * what these suites are for: a mock of `syncWorkspaceToGithub` would assert
 * that the route calls it, where this asserts what actually goes over the
 * wire — that the tree carries no `base_tree`, that a `PATCH` of the ref is
 * not forced, that an empty repository takes the `POST /git/refs` path.
 *
 * It also exercises `@octokit/auth-app` for real: a request as an installation
 * mints an App JWT (RS256, WebCrypto) and exchanges it for an installation
 * token before the call under test is issued. So the key below is a genuine
 * RSA key rather than a placeholder string — generated once per module load,
 * because 2048-bit keygen is tens of milliseconds and every suite here needs
 * exactly one.
 */

import { generateKeyPairSync } from "node:crypto";
import type { GithubAppConfig } from "./studio-github-config.ts";

/** A real 2048-bit RSA key, so App JWT signing is exercised rather than faked. */
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** The App every suite here acts as. */
export const testGithubApp: GithubAppConfig = {
  appId: "123456",
  privateKey,
  slug: "aai-studio",
  clientId: "Iv1.testclientid",
  clientSecret: "test-client-secret",
};

export const TEST_INSTALLATION_ID = 42;

/** One request the fake saw, as the assertions read it. */
export type GithubCall = {
  method: string;
  /** Pathname only — the host is always api.github.com. */
  path: string;
  body: unknown;
};

export type FakeGithubOptions = {
  /**
   * Commit the target branch points at, or `null` for a repository with no
   * commits — which is what a user who just created one for this has, and so
   * the case the sync's `POST /git/refs` path exists for.
   */
  head?: string | null;
  /** Repositories `GET /installation/repositories` answers. */
  repos?: readonly { full_name: string; private: boolean; default_branch: string }[];
  /** `User` or `Organization`, as the install callback reads it. */
  accountType?: "User" | "Organization";
  /**
   * Installations the callback's user-token check will report as theirs.
   *
   * Defaults to `[TEST_INSTALLATION_ID]` — the honest case. Set it to `[]` (or
   * to someone else's id) to drive the escalation the check exists to refuse:
   * a valid state of one's own, pointed at an installation one does not
   * administer.
   */
  userInstallations?: readonly number[];
  /** Make the `code` exchange fail, as a replayed or forged code does. */
  rejectUserCode?: boolean;
  /**
   * A repository with NO COMMITS, which refuses every Git Data write with
   * 409 until something gives it one.
   *
   * The state a user who just created a repository for this is in, and the
   * one `head: null` alone cannot express: that says the BRANCH has no
   * commit, where this says GitHub will not accept the blob that would make
   * one. Cleared by the Contents API write the sync bootstraps with, which is
   * how the real thing behaves.
   */
  emptyRepo?: boolean;
  /**
   * Force a status for requests whose path contains this fragment.
   *
   * `times` (default 1) is how many matching requests fail, which is what
   * lets a suite distinguish a conflict the sync retries THROUGH from one it
   * gives up on. `headAfter` is the concurrent push itself: the branch starts
   * at `head` and reports this once the failure has fired, so a retry reads
   * the parent somebody else's commit left behind.
   */
  failWith?: {
    pathIncludes: string;
    status: number;
    times?: number;
    headAfter?: string | null;
  };
};

export type FakeGithub = {
  fetchFn: typeof globalThis.fetch;
  /** Every request, in order. */
  calls: GithubCall[];
  /** The tree entries the last `POST /git/trees` carried. */
  treeEntries(): { path: string; sha: string; mode: string }[];
  /** Whether the last `POST /git/trees` named a `base_tree`. */
  treeHadBaseTree(): boolean;
  /** The last request to `path`, or undefined. */
  lastCall(pathIncludes: string): GithubCall | undefined;
};

/** The commit sha the fake's commit route always returns. */
export const FAKE_COMMIT_SHA = "c0ffee1234567890c0ffee1234567890c0ffee12";
/** The commit the Contents API leaves behind when it un-empties a repository. */
export const FAKE_INIT_COMMIT_SHA = "1n1t0000000000001n1t0000000000001n1t0000";
const TREE_SHA = "tree567890abcdef1234567890abcdef12345678";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** One fake route: does it match this request, and what does it answer. */
type FakeRoute = {
  method: string;
  /** True when this route answers `path`. */
  matches: (path: string) => boolean;
  reply: (call: GithubCall, ctx: FakeContext) => Response;
};

type FakeContext = {
  userInstallations: readonly number[];
  rejectUserCode: boolean;
  head: string | null;
  repos: readonly { full_name: string; private: boolean; default_branch: string }[];
  accountType: "User" | "Organization";
  /** No commits yet — the Git Data API is closed until one exists. */
  emptyRepo: boolean;
  /** How many blobs have been uploaded, so each gets a distinct sha. */
  blobCount: number;
};

const endsWith =
  (suffix: string) =>
  (path: string): boolean =>
    path.endsWith(suffix);
const contains =
  (fragment: string) =>
  (path: string): boolean =>
    path.includes(fragment);

/**
 * The routes this feature touches, as a TABLE rather than a chain of ifs.
 *
 * One entry per endpoint the code under test is allowed to call, which is
 * also the list a reviewer checks against the real API — and a shape the
 * complexity threshold does not have to be argued with.
 */
const FAKE_ROUTES: readonly FakeRoute[] = [
  // The OAuth `code` exchange — github.com rather than api.github.com, but the
  // fake keys on pathname alone.
  {
    method: "POST",
    matches: (path) => path === "/login/oauth/access_token",
    reply: (_call, ctx) =>
      ctx.rejectUserCode
        ? json({ error: "bad_verification_code" })
        : json({ access_token: "gho_user_token", token_type: "bearer" }),
  },
  // What the user finishing the install actually administers.
  {
    method: "GET",
    matches: (path) => path === "/user/installations",
    reply: (_call, ctx) =>
      json({
        total_count: ctx.userInstallations.length,
        installations: ctx.userInstallations.map((id) => ({ id })),
      }),
  },
  // The installation-token exchange — @octokit/auth-app's own first call.
  {
    method: "POST",
    matches: endsWith("/access_tokens"),
    reply: () =>
      json({
        token: "ghs_installation_token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: { contents: "write" },
      }),
  },
  {
    method: "GET",
    matches: (path) => path.startsWith("/app/installations/"),
    reply: (_call, ctx) =>
      json({ id: TEST_INSTALLATION_ID, account: { login: "acme", type: ctx.accountType } }),
  },
  {
    method: "GET",
    matches: (path) => path === "/installation/repositories",
    reply: (_call, ctx) => json({ total_count: ctx.repos.length, repositories: ctx.repos }),
  },
  {
    method: "POST",
    matches: endsWith("/repos"),
    reply: (call) => {
      const name = (call.body as { name?: string } | undefined)?.name ?? "new-repo";
      return json({ full_name: `acme/${name}`, private: true, default_branch: "main" }, 201);
    },
  },
  {
    method: "GET",
    matches: (path) => /^\/repos\/[^/]+\/[^/]+$/.test(path),
    reply: () => json({ default_branch: "main" }),
  },
  {
    method: "GET",
    matches: contains("/git/ref/"),
    // 404 is what BOTH "no such branch" and "empty repository" look like.
    reply: (_call, ctx) =>
      ctx.head === null
        ? json({ message: "Not Found" }, 404)
        : json({ object: { sha: ctx.head, type: "commit" } }),
  },
  {
    method: "POST",
    matches: endsWith("/git/blobs"),
    // GitHub's real refusal on a repository with no commits, and the reason
    // the sync bootstraps through the Contents API — a blob is the FIRST
    // write the push makes, so nothing downstream of it was ever reached.
    reply: (_call, ctx) =>
      ctx.emptyRepo
        ? json({ message: "Git Repository is empty." }, 409)
        : // A distinct sha per blob, so a tree assertion can tell entries apart.
          json({ sha: `blob${String(ctx.blobCount++).padStart(36, "0")}` }, 201),
  },
  {
    method: "PUT",
    matches: contains("/contents/"),
    // The one endpoint that writes to a repository with no commits: it makes
    // the default branch and the first commit, which is exactly what un-blocks
    // everything above.
    reply: (_call, ctx) => {
      ctx.emptyRepo = false;
      ctx.head = FAKE_INIT_COMMIT_SHA;
      return json({ commit: { sha: FAKE_INIT_COMMIT_SHA } }, 201);
    },
  },
  { method: "POST", matches: endsWith("/git/trees"), reply: () => json({ sha: TREE_SHA }, 201) },
  {
    method: "POST",
    matches: endsWith("/git/commits"),
    reply: () => json({ sha: FAKE_COMMIT_SHA }, 201),
  },
  {
    method: "POST",
    matches: endsWith("/git/refs"),
    reply: () => json({ ref: "refs/heads/main", object: { sha: FAKE_COMMIT_SHA } }, 201),
  },
  {
    method: "PATCH",
    matches: contains("/git/refs/"),
    reply: () => json({ ref: "refs/heads/main", object: { sha: FAKE_COMMIT_SHA } }),
  },
];

/**
 * A fake GitHub over the routes above.
 *
 * An unrecognized path answers **501 naming it** rather than a plausible
 * empty object: a fake that quietly answers everything turns "the code called
 * a route nobody wrote" into a passing test, which is the failure mode a
 * hand-written double is most prone to.
 */
export function createFakeGithub(options: FakeGithubOptions = {}): FakeGithub {
  const calls: GithubCall[] = [];
  const ctx: FakeContext = {
    userInstallations: options.userInstallations ?? [TEST_INSTALLATION_ID],
    rejectUserCode: options.rejectUserCode === true,
    head: options.head ?? null,
    repos: options.repos ?? [
      { full_name: "acme/voice-agent", private: true, default_branch: "main" },
    ],
    accountType: options.accountType ?? "Organization",
    emptyRepo: options.emptyRepo === true,
    blobCount: 0,
  };
  let failures = 0;

  /**
   * The injected failure, when this call is one of the ones it claims.
   *
   * Split out of `fetchFn` rather than inlined because it is the half with a
   * policy in it — how many calls fail, and what the branch looks like
   * afterwards — while the caller around it is plumbing.
   */
  const injectedFailure = (call: GithubCall): Response | null => {
    const fail = options.failWith;
    if (!fail || failures >= (fail.times ?? 1)) return null;
    // Never on the token exchange: a failure injected for the call under test
    // must not be spent on the auth round trip that precedes it.
    if (call.path.endsWith("/access_tokens") || !call.path.includes(fail.pathIncludes)) return null;
    failures += 1;
    if (fail.headAfter !== undefined) ctx.head = fail.headAfter;
    return json({ message: "injected failure" }, fail.status);
  };

  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const call: GithubCall = {
      method: init?.method ?? "GET",
      path: url.pathname,
      body: raw === undefined ? undefined : JSON.parse(raw),
    };
    calls.push(call);

    const injected = injectedFailure(call);
    if (injected) return injected;

    const route = FAKE_ROUTES.find(
      (entry) => entry.method === call.method && entry.matches(call.path),
    );
    return route
      ? route.reply(call, ctx)
      : json({ message: `fake github has no route for ${call.method} ${call.path}` }, 501);
  };

  const lastCall = (pathIncludes: string): GithubCall | undefined =>
    calls.filter((call) => call.path.includes(pathIncludes)).at(-1);

  const treeBody = (): { tree?: unknown; base_tree?: unknown } =>
    (lastCall("/git/trees")?.body as { tree?: unknown; base_tree?: unknown } | undefined) ?? {};

  return {
    fetchFn,
    calls,
    treeEntries: () => {
      const { tree } = treeBody();
      return Array.isArray(tree) ? (tree as { path: string; sha: string; mode: string }[]) : [];
    },
    treeHadBaseTree: () => treeBody().base_tree !== undefined,
    lastCall,
  };
}
