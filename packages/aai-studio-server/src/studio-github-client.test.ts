// Copyright 2026 the AAI authors. MIT license.
// The GitHub client and the repository questions the sync asks of it
// (studio-github-client.ts), against the fake GitHub every GitHub suite
// shares. What the routes do with the answers is studio-github-routes.test.ts.

import { RequestError } from "@octokit/request-error";
import { describe, expect, test } from "vitest";
import {
  createFakeGithub,
  TEST_INSTALLATION_ID,
  testGithubApp,
} from "./_studio-github-test-utils.ts";
import {
  createGithubOctokit,
  createGithubUserOctokit,
  createOrgRepo,
  githubErrorStatus,
  listInstallationRepos,
  readRepoDefaultBranch,
  resolveInstallation,
} from "./studio-github-client.ts";

/** An installation-scoped client over `fetchFn`. */
const installationClient = (fetchFn: typeof globalThis.fetch) =>
  createGithubOctokit(testGithubApp, { installationId: TEST_INSTALLATION_ID, fetchFn });

describe("githubErrorStatus", () => {
  test("reads the status off a RequestError, and nothing else", () => {
    const notFound = new RequestError("Not Found", 404, {
      request: { method: "GET", url: "https://api.github.com/x", headers: {} },
    });
    expect(githubErrorStatus(notFound)).toBe(404);
    // Duck-typed lookalikes are not GitHub's answer.
    expect(githubErrorStatus({ status: 404, message: "Not Found" })).toBeUndefined();
    expect(githubErrorStatus({ status: "404" })).toBeUndefined();
    expect(githubErrorStatus(new Error("404 Not Found"))).toBeUndefined();
    expect(githubErrorStatus("404")).toBeUndefined();
  });
});

describe("deadline", () => {
  test("every client sends a deadline signal, composed with the caller's", async () => {
    const github = createFakeGithub();
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetchFn: typeof globalThis.fetch = (input, init) => {
      signals.push(init?.signal);
      return github.fetchFn(input, init);
    };
    await readRepoDefaultBranch(installationClient(fetchFn), "acme", "voice-agent");
    const caller = new AbortController();
    await createGithubUserOctokit("gho_user", fetchFn).request("GET /user/installations", {
      request: { signal: caller.signal },
    });

    expect(signals.length).toBeGreaterThan(1);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
    // Composed, never replaced: the caller's abort still ends the request,
    // and the others stay live.
    const signalled = signals.at(-1);
    expect(signalled).not.toBe(caller.signal);
    caller.abort();
    expect(signalled?.aborted).toBe(true);
    expect(signals[0]?.aborted).toBe(false);
  });
});

describe("resolveInstallation", () => {
  test.each(["Organization", "User"] as const)(
    "resolves an installation on a %s account",
    async (accountType) => {
      const github = createFakeGithub({ accountType });
      const account = await resolveInstallation(testGithubApp, TEST_INSTALLATION_ID, {
        fetchFn: github.fetchFn,
      });
      expect(account).toEqual({ account: "acme", accountType });
      expect(github.lastCall("/app/installations/")?.path).toBe(
        `/app/installations/${TEST_INSTALLATION_ID}`,
      );
    },
  );

  test("an installation GitHub does not know is null, so it is never stored", async () => {
    const github = createFakeGithub({
      failWith: { pathIncludes: "/app/installations/", status: 404 },
    });
    expect(await resolveInstallation(testGithubApp, 999, { fetchFn: github.fetchFn })).toBeNull();
  });

  test("any other GitHub failure propagates", async () => {
    const github = createFakeGithub({
      failWith: { pathIncludes: "/app/installations/", status: 500 },
    });
    await expect(
      resolveInstallation(testGithubApp, TEST_INSTALLATION_ID, { fetchFn: github.fetchFn }),
    ).rejects.toMatchObject({ status: 500 });
  });
});

describe("listInstallationRepos", () => {
  test("lists the installation's own repositories in one short page", async () => {
    const github = createFakeGithub({
      repos: [
        { full_name: "acme/voice-agent", private: true, default_branch: "main" },
        { full_name: "acme/site", private: false, default_branch: "trunk" },
      ],
    });
    expect(await listInstallationRepos(installationClient(github.fetchFn))).toEqual([
      { fullName: "acme/voice-agent", private: true },
      { fullName: "acme/site", private: false },
    ]);
    expect(github.calls.filter((c) => c.path === "/installation/repositories")).toHaveLength(1);
  });

  test("walks full pages, and stops at its page bound", async () => {
    // A fake that answers every page full: only the bound ends the walk.
    const github = createFakeGithub({
      repos: Array.from({ length: 100 }, (_, i) => ({
        full_name: `acme/r${i}`,
        private: true,
        default_branch: "main",
      })),
    });
    const repos = await listInstallationRepos(installationClient(github.fetchFn));
    expect(github.calls.filter((c) => c.path === "/installation/repositories")).toHaveLength(10);
    expect(repos).toHaveLength(1000);
  });
});

describe("readRepoDefaultBranch", () => {
  test("reads the branch from the repository at sync time", async () => {
    const github = createFakeGithub();
    expect(
      await readRepoDefaultBranch(installationClient(github.fetchFn), "acme", "voice-agent"),
    ).toBe("main");
    expect(github.lastCall("/repos/acme/voice-agent")?.method).toBe("GET");
  });

  test("a blank default branch falls back to main", async () => {
    const github = createFakeGithub();
    const fetchFn: typeof globalThis.fetch = (input, init) =>
      new URL(String(input)).pathname === "/repos/acme/empty"
        ? Promise.resolve(Response.json({ default_branch: "" }))
        : github.fetchFn(input, init);
    expect(await readRepoDefaultBranch(installationClient(fetchFn), "acme", "empty")).toBe("main");
  });
});

describe("createOrgRepo", () => {
  test("creates a PRIVATE, uninitialized repository under the organization", async () => {
    const github = createFakeGithub();
    const repo = await createOrgRepo(installationClient(github.fetchFn), "acme", "new-agent");
    expect(repo).toEqual({ fullName: "acme/new-agent", private: true });
    const create = github.lastCall("/orgs/acme/repos");
    expect(create?.method).toBe("POST");
    expect(create?.body).toMatchObject({ name: "new-agent", private: true, auto_init: false });
  });
});
