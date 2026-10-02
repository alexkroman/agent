// Copyright 2026 the AAI authors. MIT license.
// What an install callback ESTABLISHED (studio-github-connect.ts): which
// installation, if any, the arriving user may link — decided against GitHub,
// never from the redirect alone. How the route turns each outcome into a
// redirect is studio-github-routes.test.ts.

import { createMemorySecretStore, type SecretStore } from "aai-server/stores";
import { captureLogs } from "aai-server/test-utils";
import { beforeEach, describe, expect, test } from "vitest";
import {
  createFakeGithub,
  type FakeGithubOptions,
  TEST_INSTALLATION_ID,
  testGithubApp,
} from "./_studio-github-test-utils.ts";
import { completeGithubConnect } from "./studio-github-connect.ts";
import { readGithubLink } from "./studio-github-link.ts";

const UID = "user-1";
const logs = captureLogs();

let secrets: SecretStore;
beforeEach(() => {
  secrets = createMemorySecretStore();
});

/** Run the callback decision against a fake GitHub shaped by `github`. */
async function connect(
  args: { code?: string; rawInstallationId?: string | undefined },
  github: FakeGithubOptions = {},
) {
  const fake = createFakeGithub(github);
  const outcome = await completeGithubConnect({
    config: testGithubApp,
    secrets,
    uid: UID,
    code: args.code ?? "oauth-code",
    rawInstallationId: args.rawInstallationId,
    fetchFn: fake.fetchFn,
  });
  return {
    outcome,
    calls: fake.calls.map((c) => c.path),
    link: await readGithubLink(secrets, UID),
  };
}

describe("completeGithubConnect", () => {
  test("links an installation the redirect names and the user administers", async () => {
    const { outcome, link } = await connect({ rawInstallationId: String(TEST_INSTALLATION_ID) });
    expect(outcome).toBe("connected");
    expect(link).toMatchObject({
      installationId: TEST_INSTALLATION_ID,
      account: "acme",
      accountType: "Organization",
    });
  });

  test("with no id in the redirect, links the newest installation the user holds", async () => {
    const { outcome, link } = await connect(
      { rawInstallationId: undefined },
      { userInstallations: [77, TEST_INSTALLATION_ID] },
    );
    expect(outcome).toBe("connected");
    expect(link?.installationId).toBe(77);
  });

  test("an empty id reads as absent, not as a broken redirect", async () => {
    expect((await connect({ rawInstallationId: "" })).outcome).toBe("connected");
  });

  test("someone else's installation is refused before GitHub is asked about it", async () => {
    // The enumeration the check exists for: a valid state of one's own,
    // pointed at an installation one does not administer.
    const { outcome, calls, link } = await connect(
      { rawInstallationId: String(TEST_INSTALLATION_ID) },
      { userInstallations: [] },
    );
    expect(outcome).toBe("unverified");
    expect(calls.some((path) => path.startsWith("/app/installations/"))).toBe(false);
    expect(link).toBeNull();
    expect(logs.warns()).toEqual([expect.stringContaining("refused an unverified installation")]);
  });

  test.each([
    ["no code", { code: "" }, {}],
    ["a code GitHub will not exchange", {}, { rejectUserCode: true }],
  ])("%s establishes nothing about the caller", async (_label, args, github) => {
    const { outcome, link } = await connect(args, github);
    expect(outcome).toBe("unverified");
    expect(link).toBeNull();
  });

  test("a user who holds no installation is sent to install the App", async () => {
    const { outcome, link } = await connect(
      { rawInstallationId: undefined },
      { userInstallations: [] },
    );
    expect(outcome).toBe("install");
    expect(link).toBeNull();
  });

  test.each(["abc", "0", "-3", "1.5"])("an id of %j could never be one, and fails", async (raw) => {
    const { outcome, calls } = await connect({ rawInstallationId: raw });
    expect(outcome).toBe("failed");
    expect(calls).toEqual([]);
  });

  test("an installation GitHub no longer knows fails and records nothing", async () => {
    const { outcome, link } = await connect(
      { rawInstallationId: String(TEST_INSTALLATION_ID) },
      { failWith: { pathIncludes: "/app/installations/", status: 404 } },
    );
    expect(outcome).toBe("failed");
    expect(link).toBeNull();
  });
});
