// Copyright 2026 the AAI authors. MIT license.
// The push itself: workspace file map -> blobs -> tree -> commit -> ref.
//
// Driven through Octokit against `createFakeGithub`, so what is asserted is
// what goes over the wire. The three properties the module header argues for
// are each one test here, because each is invisible from a mocked wrapper: the
// tree carries no `base_tree` (a delete must propagate), the ref PATCH is not
// forced (a concurrent push must not be discarded), and an empty repository
// creates the ref rather than updating one.

import { describe, expect, test } from "vitest";
import {
  createFakeGithub,
  FAKE_COMMIT_SHA,
  TEST_INSTALLATION_ID,
  testGithubApp,
} from "./_studio-github-test-utils.ts";
import { createGithubOctokit } from "./studio-github-client.ts";
import {
  GithubRefConflictError,
  githubSyncErrorMessage,
  parseRepoFullName,
  syncWorkspaceToGithub,
} from "./studio-github-sync.ts";
import type { StudioWorkspace } from "./studio-workspace.ts";

const workspace = (files: Record<string, string>, hash = "hash-1"): StudioWorkspace => ({
  files,
  hash,
  updatedAt: 0,
});

const target = { owner: "acme", repo: "voice-agent", branch: "main" };

const runSync = (
  github: ReturnType<typeof createFakeGithub>,
  overrides: Partial<Parameters<typeof syncWorkspaceToGithub>[0]> = {},
) =>
  syncWorkspaceToGithub({
    // The client the route builds, built here for the same reason: one
    // instance is one installation-token exchange.
    octokit: createGithubOctokit(testGithubApp, {
      installationId: TEST_INSTALLATION_ID,
      fetchFn: github.fetchFn,
    }),
    workspace: workspace({ "agent.ts": "export default 1;" }),
    target,
    project: "demo",
    ...overrides,
  });

describe("parseRepoFullName", () => {
  test("accepts owner/repo and rejects everything else", () => {
    expect(parseRepoFullName("acme/voice-agent")).toEqual({ owner: "acme", repo: "voice-agent" });
    // Both halves become path segments in every request the sync makes, so the
    // rejections are the load-bearing half: a slash-carrying "name" would be a
    // request to an endpoint nobody wrote.
    expect(parseRepoFullName("acme")).toBeNull();
    expect(parseRepoFullName("acme/voice/agent")).toBeNull();
    expect(parseRepoFullName("/voice-agent")).toBeNull();
    expect(parseRepoFullName("acme/")).toBeNull();
    expect(parseRepoFullName("ac me/voice-agent")).toBeNull();
    expect(parseRepoFullName("../../etc/passwd")).toBeNull();
  });
});

describe("syncWorkspaceToGithub", () => {
  test("an empty repository CREATES the ref and commits with no parent", async () => {
    // The common first sync: the user made a repository for this, so there is
    // no ref to read a parent from. Both halves matter — a commit with a
    // fabricated parent is rejected, and a PATCH of a ref that does not exist
    // 404s.
    const github = createFakeGithub({ head: null });
    const result = await runSync(github);

    expect(result.changed).toBe(true);
    expect(result.commitSha).toBe(FAKE_COMMIT_SHA);
    expect(result.commitUrl).toBe(`https://github.com/acme/voice-agent/commit/${FAKE_COMMIT_SHA}`);
    expect(github.lastCall("/git/commits")?.body).toMatchObject({ parents: [] });
    expect(github.lastCall("/git/refs")?.method).toBe("POST");
    expect(github.calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  test("an existing branch is a fast-forward PATCH naming the old head as parent", async () => {
    const github = createFakeGithub({ head: "abc123" });
    await runSync(github);

    expect(github.lastCall("/git/commits")?.body).toMatchObject({ parents: ["abc123"] });
    const patch = github.lastCall("/git/refs/");
    expect(patch?.method).toBe("PATCH");
    // NOT forced: a non-fast-forward here means somebody pushed while the
    // blobs were uploading, and discarding their commit silently is the one
    // outcome a sync must never produce.
    expect(patch?.body).toMatchObject({ force: false, sha: FAKE_COMMIT_SHA });
  });

  test("the tree is written WHOLE — no base_tree, so a delete propagates", async () => {
    // The property the module header argues for. Layered onto the existing
    // tree, a file deleted in the studio would survive in the repository
    // forever, which is the one thing "sync" must not mean.
    const github = createFakeGithub({ head: "abc123" });
    await runSync(github, {
      workspace: workspace({ "agent.ts": "a", "client.tsx": "b" }),
    });

    expect(github.treeHadBaseTree()).toBe(false);
    expect(
      github
        .treeEntries()
        .map((entry) => entry.path)
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["agent.ts", "client.tsx"]);
    expect(github.treeEntries().every((entry) => entry.mode === "100644")).toBe(true);
  });

  test("file content goes up base64-encoded, byte-exact", async () => {
    // A workspace holds whatever the coding agent wrote; the JSON `utf-8`
    // encoding does not round-trip every byte and base64 does.
    const github = createFakeGithub({ head: "abc123" });
    await runSync(github, { workspace: workspace({ "a.ts": 'const emoji = "🎙";' }) });

    const blob = github.lastCall("/git/blobs")?.body as { content: string; encoding: string };
    expect(blob.encoding).toBe("base64");
    expect(Buffer.from(blob.content, "base64").toString("utf8")).toBe('const emoji = "🎙";');
  });

  test("a workspace already at syncedHash is a no-op — no blobs, no commit", async () => {
    // Pressing Sync twice with no edits between must not produce two commits
    // of identical content. Same shape as the preview deploy's previewHash.
    const github = createFakeGithub({ head: "abc123" });
    const result = await runSync(github, { syncedHash: "hash-1" });

    expect(result.changed).toBe(false);
    expect(result.commitSha).toBe("abc123");
    expect(github.calls.some((call) => call.path.includes("/git/blobs"))).toBe(false);
    expect(github.calls.some((call) => call.path.includes("/git/commits"))).toBe(false);
  });

  test("a matching syncedHash against a repository with NO head still pushes", async () => {
    // The stamp claims the branch is current; the branch does not exist. That
    // is a repository recreated under the same name, which users really do —
    // believing the stamp there would leave them with an empty repository and
    // a studio reporting success.
    const github = createFakeGithub({ head: null });
    const result = await runSync(github, { syncedHash: "hash-1" });

    expect(result.changed).toBe(true);
    expect(github.calls.some((call) => call.path.includes("/git/commits"))).toBe(true);
  });

  test("the commit message names the project", async () => {
    const github = createFakeGithub({ head: "abc123" });
    await runSync(github, { project: "contact-form-x7k2mq" });
    expect(github.lastCall("/git/commits")?.body).toMatchObject({
      message: "Sync contact-form-x7k2mq from AAI Studio",
    });
  });

  test("a 409 from the ref read is an empty repository, not a failure", async () => {
    // GitHub's specific "Git Repository is empty" — it means the same thing
    // as the 404 and must take the same path.
    const github = createFakeGithub({
      head: "abc123",
      failWith: { pathIncludes: "/git/ref/", status: 409 },
    });
    const result = await runSync(github);

    expect(result.changed).toBe(true);
    expect(github.lastCall("/git/refs")?.method).toBe("POST");
  });

  test("a failure that is not the empty-repository case propagates", async () => {
    const github = createFakeGithub({
      head: "abc123",
      failWith: { pathIncludes: "/git/trees", status: 403 },
    });
    await expect(runSync(github)).rejects.toThrow();
  });

  test("a head that moved is rebuilt onto — the sync retries, it does not advise", async () => {
    // The race the unforced PATCH exists to catch: somebody pushed while the
    // blobs were uploading. Telling the user to press Sync again is this same
    // loop run by hand, so the sync runs it.
    const github = createFakeGithub({
      head: "abc123",
      failWith: { pathIncludes: "/git/refs/", status: 422, headAfter: "def456" },
    });
    const result = await runSync(github);

    expect(result.changed).toBe(true);
    // Two commits, the second naming THEIR commit as its parent — their work
    // is carried forward rather than discarded, which is what `force: false`
    // buys and what the retry is obliged to preserve.
    const commits = github.calls.filter((call) => call.path.endsWith("/git/commits"));
    expect(commits).toHaveLength(2);
    expect(commits.at(-1)?.body).toMatchObject({ parents: ["def456"] });
    // ONE upload: the tree is content-addressed, so a moved head changes which
    // commit is built and never which tree it carries.
    expect(github.calls.filter((call) => call.path.endsWith("/git/blobs"))).toHaveLength(1);
    expect(github.calls.filter((call) => call.path.endsWith("/git/trees"))).toHaveLength(1);
  });

  test("a ref CREATE that lost the race switches to updating the ref", async () => {
    // Both syncs read no head and both created; the loser's 422 is
    // "Reference already exists", the same situation as the non-fast-forward
    // seen from the other path — and equally not a reason to fail.
    const github = createFakeGithub({
      head: null,
      failWith: { pathIncludes: "/git/refs", status: 422, headAfter: "def456" },
    });
    const result = await runSync(github);

    expect(result.changed).toBe(true);
    expect(github.lastCall("/git/refs/")?.method).toBe("PATCH");
    expect(github.lastCall("/git/commits")?.body).toMatchObject({ parents: ["def456"] });
  });

  test("a ref CREATE refused while the ref still does not exist keeps GitHub's words", async () => {
    // Nothing raced — the ref name itself is being rejected, so a second
    // create is the same request with the same answer. This is the case the
    // old blanket "try again" turned into a loop the user could not break.
    const github = createFakeGithub({
      head: null,
      failWith: { pathIncludes: "/git/refs", status: 422, times: 10 },
    });

    await expect(runSync(github)).rejects.toSatisfy(
      (err: unknown) => !(err instanceof GithubRefConflictError),
    );
    // One attempt, not three: a retry here could never do anything different.
    expect(github.calls.filter((call) => call.path.endsWith("/git/refs"))).toHaveLength(1);
  });

  test("a branch that keeps moving gives up as a conflict, not as a GitHub status", async () => {
    // The retries are bounded, so a branch under constant push terminates —
    // and terminates as the one failure "try again" is honest advice for.
    const github = createFakeGithub({
      head: "abc123",
      failWith: { pathIncludes: "/git/refs/", status: 422, times: 10, headAfter: "def456" },
    });

    await expect(runSync(github)).rejects.toBeInstanceOf(GithubRefConflictError);
    expect(github.calls.filter((call) => call.method === "PATCH")).toHaveLength(3);
  });
});

describe("githubSyncErrorMessage", () => {
  test("names the fix for each status this flow really produces", () => {
    // Each sentence has to name the ACTION, not the symptom: these are the
    // three misconfigurations a user meets, and "sync failed" leaves all of
    // them looking like a bug in the studio.
    expect(githubSyncErrorMessage({ status: 404 })).toContain("reconnect GitHub");
    expect(githubSyncErrorMessage({ status: 401 })).toContain("reconnect GitHub");
    expect(githubSyncErrorMessage({ status: 403 })).toContain("Contents: read and write");
    // Only the sync's OWN verdict, reached after the retries are spent, may
    // say the branch moved. A bare 409 or 422 is a request GitHub refuses on
    // its merits, and "try again" is advice that cannot ever work.
    expect(githubSyncErrorMessage(new GithubRefConflictError("main"))).toContain(
      "moved while the sync was running",
    );
    expect(githubSyncErrorMessage({ status: 422, message: "tree.path is invalid" })).toBe(
      "tree.path is invalid",
    );
    expect(githubSyncErrorMessage({ status: 409, message: "Git Repository is empty" })).toBe(
      "Git Repository is empty",
    );
  });

  test("an unanticipated failure keeps its own words", () => {
    // Verbatim beats flattening: a message we did not plan for is more useful
    // as GitHub wrote it.
    expect(githubSyncErrorMessage(new Error("socket hang up"))).toBe("socket hang up");
    expect(githubSyncErrorMessage({ status: 500, message: "x" })).not.toContain("reconnect");
  });
});
