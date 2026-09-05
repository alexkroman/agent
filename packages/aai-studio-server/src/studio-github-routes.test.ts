// Copyright 2026 the AAI authors. MIT license.
// The GitHub surface end to end, through the combined app: a signed-in browser
// session connects an installation, picks a repository, and syncs a project.
//
// Driven against the real routes with a fake GITHUB (`createFakeGithub`) and
// real dev auth — so what is exercised is the middleware, the signed state,
// the installation resolution, the workspace stamp, and the refusals. The
// callback in particular is a PUBLIC route whose only authentication is the
// state, so its negative cases carry the weight here.

import { createMemorySecretStore, type SecretStore } from "aai-server/stores";
import { authFetch, type TestFetch } from "aai-server/test-utils";
import { beforeEach, describe, expect, test } from "vitest";
import { devToken, onboardKey, withDevAuth } from "./_studio-auth-test-utils.ts";
import {
  createFakeGithub,
  FAKE_COMMIT_SHA,
  type FakeGithub,
  TEST_INSTALLATION_ID,
  testGithubApp,
} from "./_studio-github-test-utils.ts";
import { createProject } from "./_studio-routes-test-utils.ts";
import { githubLinkSecretName } from "./studio-github-link.ts";
import { signInstallState } from "./studio-github-state.ts";

const bearer = devToken("dev@example.com");
const UID = "dev:dev@example.com";

type Harness = Awaited<ReturnType<typeof withDevAuth>> & {
  github: FakeGithub;
  /**
   * The harness's own secret store, held here because the combined harness
   * does not return one — and the link record is what several of these tests
   * assert on directly. Reading the STORE rather than a route is deliberate
   * for the callback: it is the only way to show a forged state linked
   * nothing, since the route it would otherwise be read through requires the
   * session the callback deliberately has none of.
   */
  secrets: SecretStore;
};

/** A signed-in, key-onboarded session against a studio with a GitHub App. */
async function studio(options: Parameters<typeof createFakeGithub>[0] = {}): Promise<Harness> {
  const github = createFakeGithub(options);
  const secrets = createMemorySecretStore();
  const harness = await withDevAuth({
    githubApp: testGithubApp,
    githubFetch: github.fetchFn,
    secrets,
  });
  await onboardKey(harness.fetch, bearer);
  return { ...harness, github, secrets };
}

// `authFetch` defaults to POST, so a GET has to say so — a POST to a
// GET-only route 404s, which reads as a missing route rather than a wrong verb.
const get = (fetch: TestFetch, path: string) =>
  authFetch(fetch, path, { method: "GET", key: bearer });
const post = (fetch: TestFetch, path: string, body: unknown = {}) =>
  authFetch(fetch, path, { method: "POST", key: bearer, body });

// Both helpers THROW rather than `expect`, because an assertion outside a
// test body reports against whichever test happens to be running — and these
// are setup, so a failure here means the fixture is broken, not the claim.
/** Connect the account, the way the callback does. */
async function connect(harness: Harness): Promise<void> {
  const state = signInstallState(testGithubApp, { uid: UID });
  const res = await harness.fetch(
    `/studio/github/callback?installation_id=${TEST_INSTALLATION_ID}&code=user-code&state=${encodeURIComponent(state)}`,
  );
  if (res.status !== 302) throw new Error(`connect fixture failed: ${res.status}`);
}

/** A project with starter files, so a sync has something to push. */
async function makeProject(harness: Harness, name = "demo"): Promise<void> {
  // The shared fixture, not a fourth spelling of the create call.
  const res = await createProject(harness.fetch, name, bearer);
  if (res.status !== 201) throw new Error(`project fixture failed: ${res.status}`);
}

describe("GET /studio/github", () => {
  test("a platform with no GitHub App reports itself unconfigured", async () => {
    // The client renders NOTHING for this, so it must be distinguishable from
    // "you have not connected" — which is a thing the user can fix.
    const harness = await withDevAuth();
    await onboardKey(harness.fetch, bearer);
    const res = await get(harness.fetch, "/studio/github");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, connected: false });
  });

  test("configured but not connected, then connected names the account", async () => {
    const harness = await studio();
    expect(await (await get(harness.fetch, "/studio/github")).json()).toMatchObject({
      configured: true,
      connected: false,
      manageUrl: "https://github.com/apps/aai-studio/installations/new",
    });

    await connect(harness);
    expect(await (await get(harness.fetch, "/studio/github")).json()).toMatchObject({
      configured: true,
      connected: true,
      account: "acme",
      accountType: "Organization",
    });
  });

  test("requires a session", async () => {
    const harness = await studio();
    expect((await harness.fetch("/studio/github")).status).toBe(401);
  });
});

describe("POST /studio/github/connect", () => {
  test("mints an AUTHORIZE URL carrying a state this server will accept", async () => {
    const harness = await studio();
    const res = await post(harness.fetch, "/studio/github/connect", { project: "demo" });
    expect(res.status).toBe(200);

    const { installUrl } = (await res.json()) as { installUrl: string };
    const url = new URL(installUrl);
    // NOT `/apps/<slug>/installations/new`: that page does not redirect back
    // for an App the user has already installed, which strands the flow with
    // the App visibly installed and the studio's button still saying Connect.
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(testGithubApp.clientId);
    // Minted at CLICK time rather than handed out with the status, because the
    // state expires — so the one thing worth asserting is that the round trip
    // it starts really lands.
    const state = url.searchParams.get("state") ?? "";
    const callback = await harness.fetch(
      `/studio/github/callback?installation_id=${TEST_INSTALLATION_ID}&code=user-code&state=${encodeURIComponent(state)}`,
    );
    expect(callback.headers.get("location")).toBe("/studio/chat/demo?github=connected");
  });

  test("501 when the platform has no App", async () => {
    const harness = await withDevAuth();
    await onboardKey(harness.fetch, bearer);
    expect((await post(harness.fetch, "/studio/github/connect")).status).toBe(501);
  });
});

describe("GET /studio/github/callback", () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await studio();
  });

  test("a valid state links the installation and returns the browser home", async () => {
    const state = signInstallState(testGithubApp, { uid: UID });
    const res = await harness.fetch(
      `/studio/github/callback?installation_id=${TEST_INSTALLATION_ID}&code=user-code&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(302);
    // No project hint: home, not a dead project URL.
    expect(res.headers.get("location")).toBe("/?github=connected");
    expect(await harness.secrets.get(githubLinkSecretName(UID))).toContain("acme");
  });

  test("an ALREADY-INSTALLED App links without any installation_id", async () => {
    // The bug this whole flow was reshaped for. GitHub sends `installation_id`
    // only when the App was installed during the round trip, so a user who
    // installed it earlier — a first attempt that was interrupted, another
    // studio account, or installing it from GitHub directly — comes back with
    // a `code` and nothing else. Refusing that is what left the App visibly
    // installed while the card kept offering Connect, forever.
    const state = signInstallState(testGithubApp, { uid: UID, project: "demo" });
    const res = await harness.fetch(
      `/studio/github/callback?code=user-code&state=${encodeURIComponent(state)}`,
    );
    expect(res.headers.get("location")).toBe("/studio/chat/demo?github=connected");
    expect(await harness.secrets.get(githubLinkSecretName(UID))).toContain("acme");
  });

  test("no installation at all sends the user on to the install page", async () => {
    // Authorizing without installing is a legitimate half-finished flow, not a
    // failure — so it continues rather than reporting one, and the state it
    // carries is what makes the return trip land back here.
    const github = createFakeGithub({ userInstallations: [] });
    const secrets = createMemorySecretStore();
    const fresh = await withDevAuth({
      githubApp: testGithubApp,
      githubFetch: github.fetchFn,
      secrets,
    });
    await onboardKey(fresh.fetch, bearer);

    const state = signInstallState(testGithubApp, { uid: UID, project: "demo" });
    const res = await fresh.fetch(
      `/studio/github/callback?code=user-code&state=${encodeURIComponent(state)}`,
    );
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toBe("/apps/aai-studio/installations/new");
    expect(location.searchParams.get("state")).not.toBe("");
    expect(await secrets.get(githubLinkSecretName(UID))).toBeNull();
  });

  test("a forged state links NOTHING", async () => {
    // The whole attack: `?state=` naming a victim's uid would otherwise attach
    // the attacker's installation to the victim's account, and every later
    // sync of theirs would push into a repository the attacker controls.
    const forged = `${Buffer.from(JSON.stringify({ uid: UID, exp: Date.now() + 60_000 }))
      .toString("base64url")
      .replace(/=+$/, "")}.forged`;
    const res = await harness.fetch(
      `/studio/github/callback?installation_id=${TEST_INSTALLATION_ID}&code=user-code&state=${encodeURIComponent(forged)}`,
    );
    expect(res.headers.get("location")).toBe("/?github=expired");
    expect(await harness.secrets.get(githubLinkSecretName(UID))).toBeNull();
  });

  test("an expired state links nothing", async () => {
    const stale = signInstallState(testGithubApp, { uid: UID }, Date.now() - 60 * 60_000);
    const res = await harness.fetch(
      `/studio/github/callback?installation_id=1&code=user-code&state=${encodeURIComponent(stale)}`,
    );
    expect(res.headers.get("location")).toBe("/?github=expired");
    expect(await harness.secrets.get(githubLinkSecretName(UID))).toBeNull();
  });

  test("an installation GitHub does not know links nothing", async () => {
    // The second check, and the one the signature cannot make: the state
    // proves who is asking, never what they are attaching.
    const github = createFakeGithub({
      failWith: { pathIncludes: "/app/installations/", status: 404 },
      // Entitled to it, so the refusal below is unambiguously "GitHub does not
      // know this installation" rather than the ownership check firing.
      userInstallations: [999],
    });
    const secrets = createMemorySecretStore();
    const withMissing = await withDevAuth({
      githubApp: testGithubApp,
      githubFetch: github.fetchFn,
      secrets,
    });
    await onboardKey(withMissing.fetch, bearer);
    const state = signInstallState(testGithubApp, { uid: UID, project: "demo" });
    const res = await withMissing.fetch(
      `/studio/github/callback?installation_id=999&code=user-code&state=${encodeURIComponent(state)}`,
    );
    // Back to the project the user started from, with the failure named.
    expect(res.headers.get("location")).toBe("/studio/chat/demo?github=failed");
    expect(await secrets.get(githubLinkSecretName(UID))).toBeNull();
  });

  test("an installation the signed-in user does NOT administer is refused", async () => {
    // The cross-tenant escalation this check exists for. Everything the
    // attacker supplies is legitimate: a state they minted for themselves at
    // `POST /github/connect`, and an `installation_id` that really is an
    // installation of this App. What they cannot produce is a user token whose
    // `GET /user/installations` lists it — so the link is never written, and
    // they never reach the victim's repositories.
    const github = createFakeGithub({ userInstallations: [] });
    const secrets = createMemorySecretStore();
    const attacker = await withDevAuth({
      githubApp: testGithubApp,
      githubFetch: github.fetchFn,
      secrets,
    });
    await onboardKey(attacker.fetch, bearer);

    const state = signInstallState(testGithubApp, { uid: UID });
    const res = await attacker.fetch(
      `/studio/github/callback?installation_id=${TEST_INSTALLATION_ID}&code=user-code&state=${encodeURIComponent(state)}`,
    );
    expect(res.headers.get("location")).toBe("/?github=unverified");
    expect(await secrets.get(githubLinkSecretName(UID))).toBeNull();
  });

  test("a callback with NO code links nothing", async () => {
    // The entitlement check is not optional: a caller who simply omits the
    // code must not fall through to the unverified path this replaced.
    const state = signInstallState(testGithubApp, { uid: UID });
    const res = await harness.fetch(
      `/studio/github/callback?installation_id=${TEST_INSTALLATION_ID}&state=${encodeURIComponent(state)}`,
    );
    expect(res.headers.get("location")).toBe("/?github=unverified");
    expect(await harness.secrets.get(githubLinkSecretName(UID))).toBeNull();
  });

  test("a code GitHub rejects links nothing", async () => {
    // A replayed or forged code. Same refusal — the recovery is identical.
    const github = createFakeGithub({ rejectUserCode: true });
    const secrets = createMemorySecretStore();
    const replay = await withDevAuth({
      githubApp: testGithubApp,
      githubFetch: github.fetchFn,
      secrets,
    });
    await onboardKey(replay.fetch, bearer);

    const state = signInstallState(testGithubApp, { uid: UID });
    const res = await replay.fetch(
      `/studio/github/callback?installation_id=${TEST_INSTALLATION_ID}&code=used-already&state=${encodeURIComponent(state)}`,
    );
    expect(res.headers.get("location")).toBe("/?github=unverified");
    expect(await secrets.get(githubLinkSecretName(UID))).toBeNull();
  });

  test("an EMPTY installation id reads as absent, not as malformed", async () => {
    // `Number("")` is 0, so a check that parsed before testing the string
    // turned a blank parameter into a failed connect for a user whose
    // installation the token could have resolved perfectly well.
    const state = signInstallState(testGithubApp, { uid: UID });
    const res = await harness.fetch(
      `/studio/github/callback?installation_id=&code=user-code&state=${encodeURIComponent(state)}`,
    );
    expect(res.headers.get("location")).toBe("/?github=connected");
  });

  test("a non-numeric installation id links nothing", async () => {
    const state = signInstallState(testGithubApp, { uid: UID });
    const res = await harness.fetch(
      `/studio/github/callback?installation_id=not-a-number&code=user-code&state=${encodeURIComponent(state)}`,
    );
    expect(res.headers.get("location")).toBe("/?github=failed");
    expect(await harness.secrets.get(githubLinkSecretName(UID))).toBeNull();
  });

  test("the callback needs NO bearer — that is the whole point", async () => {
    // GitHub performs this navigation, so there is nothing to authenticate
    // with. Asserted directly because a future `authMw` mounted over
    // `/studio/github/*` would break the flow with no other symptom.
    const state = signInstallState(testGithubApp, { uid: UID });
    const res = await harness.fetch(
      `/studio/github/callback?installation_id=${TEST_INSTALLATION_ID}&code=user-code&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(302);
  });
});

describe("GET /studio/github/repos", () => {
  test("lists what the installation can write", async () => {
    const harness = await studio();
    await connect(harness);
    const res = await get(harness.fetch, "/studio/github/repos");
    expect(res.status).toBe(200);
    // No default branch in the summary: a sync reads that from the repository
    // at push time, so a copy captured here could be a rename out of date.
    expect(await res.json()).toEqual({
      repos: [{ fullName: "acme/voice-agent", private: true }],
    });
  });

  test("409 before the account has connected", async () => {
    const harness = await studio();
    expect((await get(harness.fetch, "/studio/github/repos")).status).toBe(409);
  });
});

describe("POST /studio/github/repos", () => {
  test("creates under an organization", async () => {
    const harness = await studio();
    await connect(harness);
    const res = await post(harness.fetch, "/studio/github/repos", { name: "new-agent" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ repo: { fullName: "acme/new-agent" } });
  });

  test("a personal account is refused with the instruction, not a 403", async () => {
    // GitHub's own boundary: `POST /user/repos` is unavailable to an
    // installation token at all. Passing that through as a permission error
    // would read as a bug in the studio rather than as a step to take.
    const harness = await studio({ accountType: "User" });
    await connect(harness);
    const res = await post(harness.fetch, "/studio/github/repos", { name: "new-agent" });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("Create the repository on GitHub");
  });
});

describe("POST /studio/projects/:project/github/sync", () => {
  test("pushes the workspace and stamps where it landed", async () => {
    const harness = await studio({ head: "abc123" });
    await connect(harness);
    await makeProject(harness);

    const res = await post(harness.fetch, "/studio/projects/demo/github/sync", {
      repo: "acme/voice-agent",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      repo: "acme/voice-agent",
      branch: "main",
      changed: true,
      commitSha: FAKE_COMMIT_SHA,
    });

    // The stamp is what the card's "up to date" line and the next sync's
    // no-op both read.
    const project = await (await get(harness.fetch, "/studio/projects/demo")).json();
    expect(project).toMatchObject({
      githubRepo: "acme/voice-agent",
      githubBranch: "main",
      githubCommit: FAKE_COMMIT_SHA,
      githubStale: false,
    });
  });

  test("a second sync with no edits between is a no-op", async () => {
    const harness = await studio({ head: "abc123" });
    await connect(harness);
    await makeProject(harness);
    const body = { repo: "acme/voice-agent" };

    await post(harness.fetch, "/studio/projects/demo/github/sync", body);
    const before = harness.github.calls.length;
    const res = await post(harness.fetch, "/studio/projects/demo/github/sync", body);

    expect(await res.json()).toMatchObject({ changed: false });
    // Not merely "changed: false" — no blob upload happened at all.
    expect(
      harness.github.calls.slice(before).some((call) => call.path.includes("/git/blobs")),
    ).toBe(false);
  });

  test("an edit makes the project stale again and the next sync pushes", async () => {
    const harness = await studio({ head: "abc123" });
    await connect(harness);
    await makeProject(harness);
    await post(harness.fetch, "/studio/projects/demo/github/sync", { repo: "acme/voice-agent" });

    await authFetch(harness.fetch, "/studio/projects/demo/file", {
      method: "PUT",
      key: bearer,
      body: { path: "agent.ts", content: "// edited" },
    });
    const stale = await (await get(harness.fetch, "/studio/projects/demo")).json();
    expect(stale).toMatchObject({ githubStale: true });

    const res = await post(harness.fetch, "/studio/projects/demo/github/sync", {
      repo: "acme/voice-agent",
    });
    expect(await res.json()).toMatchObject({ changed: true });
  });

  test("switching repositories ignores the previous target's hash", async () => {
    // The hash describes the FILES, never where they went — so a stamp from
    // one repository must not report a brand-new destination as already in
    // sync and push nothing to it.
    const harness = await studio({
      head: "abc123",
      repos: [
        { full_name: "acme/voice-agent", private: true, default_branch: "main" },
        { full_name: "acme/other", private: false, default_branch: "main" },
      ],
    });
    await connect(harness);
    await makeProject(harness);
    await post(harness.fetch, "/studio/projects/demo/github/sync", { repo: "acme/voice-agent" });

    const res = await post(harness.fetch, "/studio/projects/demo/github/sync", {
      repo: "acme/other",
    });
    expect(await res.json()).toMatchObject({ changed: true, repo: "acme/other" });
  });

  test("409 before the account has connected GitHub", async () => {
    const harness = await studio();
    await makeProject(harness);
    const res = await post(harness.fetch, "/studio/projects/demo/github/sync", {
      repo: "acme/voice-agent",
    });
    expect(res.status).toBe(409);
  });

  test("404 for a project that does not exist", async () => {
    const harness = await studio();
    await connect(harness);
    const res = await post(harness.fetch, "/studio/projects/ghost/github/sync", {
      repo: "acme/voice-agent",
    });
    expect(res.status).toBe(404);
  });

  test("a malformed repo is refused before any GitHub call", async () => {
    const harness = await studio();
    await connect(harness);
    await makeProject(harness);
    const before = harness.github.calls.length;
    const res = await post(harness.fetch, "/studio/projects/demo/github/sync", {
      repo: "not-a-full-name",
    });
    expect(res.status).toBe(400);
    expect(harness.github.calls.length).toBe(before);
  });

  test("a RAW-KEY caller is refused — a key nobody claimed has no GitHub grant", async () => {
    // The link is keyed by studio user, and the CLI's raw key resolves to none
    // unless an account claimed it. Widening this to the workspace scope would
    // let a key inherit a browser session's repository write access.
    const github = createFakeGithub({ head: "abc123" });
    const harness = await withDevAuth({ githubApp: testGithubApp, githubFetch: github.fetchFn });
    await authFetch(harness.fetch, "/studio/projects", {
      method: "POST",
      key: "raw-api-key",
      body: { name: "cli-project" },
    });
    const res = await authFetch(harness.fetch, "/studio/projects/cli-project/github/sync", {
      method: "POST",
      key: "raw-api-key",
      body: { repo: "acme/voice-agent" },
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("in your browser");
  });

  test("a GitHub failure reaches the client as an actionable sentence", async () => {
    const harness = await studio({
      head: "abc123",
      failWith: { pathIncludes: "/git/trees", status: 403 },
    });
    await connect(harness);
    await makeProject(harness);
    const res = await post(harness.fetch, "/studio/projects/demo/github/sync", {
      repo: "acme/voice-agent",
    });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("Contents: read and write");
  });
});

describe("DELETE /studio/github", () => {
  test("forgets the link, and syncing then refuses", async () => {
    const harness = await studio({ head: "abc123" });
    await connect(harness);
    await makeProject(harness);

    const res = await authFetch(harness.fetch, "/studio/github", { method: "DELETE", key: bearer });
    expect(res.status).toBe(200);
    expect(await harness.secrets.get(githubLinkSecretName(UID))).toBeNull();

    const sync = await post(harness.fetch, "/studio/projects/demo/github/sync", {
      repo: "acme/voice-agent",
    });
    expect(sync.status).toBe(409);
  });

  test("disconnecting an account with no link is not an error", async () => {
    const harness = await studio();
    const res = await authFetch(harness.fetch, "/studio/github", { method: "DELETE", key: bearer });
    expect(res.status).toBe(200);
  });
});
