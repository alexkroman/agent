// Copyright 2026 the AAI authors. MIT license.
// The per-account record joining a studio user to a GitHub App installation.
//
// It decides whether a sync may happen at all, so the read is schema-validated
// and every way a stored document can be wrong reads as "not connected" — the
// state whose recovery (connect again) is the one the user needs.

import { createMemorySecretStore } from "aai-server/stores";
import { describe, expect, test } from "vitest";
import {
  deleteGithubLink,
  type GithubLink,
  githubLinkSecretName,
  readGithubLink,
  writeGithubLink,
} from "./studio-github-link.ts";

const link: GithubLink = {
  installationId: 42,
  account: "acme",
  accountType: "Organization",
  connectedAt: 1_700_000_000_000,
};

describe("githubLinkSecretName", () => {
  test("namespaces by user id, distinctly from the account's other records", () => {
    // It shares a store with `user-key:<uid>` and `key-user:<hash>`, so the
    // prefix is what keeps one account's records from colliding.
    expect(githubLinkSecretName("user-1")).toBe("github-install:user-1");
    expect(githubLinkSecretName("user-2")).not.toBe(githubLinkSecretName("user-1"));
  });
});

describe("readGithubLink", () => {
  test("round-trips a written link", async () => {
    const secrets = createMemorySecretStore();
    await writeGithubLink(secrets, "user-1", link);
    expect(await readGithubLink(secrets, "user-1")).toEqual(link);
  });

  test("an account with no link reads as null", async () => {
    const secrets = createMemorySecretStore();
    expect(await readGithubLink(secrets, "user-1")).toBeNull();
  });

  test("one account's link is invisible to another", async () => {
    const secrets = createMemorySecretStore();
    await writeGithubLink(secrets, "user-1", link);
    expect(await readGithubLink(secrets, "user-2")).toBeNull();
  });

  test("a malformed record reads as not connected, never as a partial link", async () => {
    // A hand-written two-field guard is one edit away from admitting a shape
    // whose `installationId` names somebody else's installation — which is
    // why this goes through a schema. Each case below would pass a guard that
    // only checked presence.
    const secrets = createMemorySecretStore();
    for (const raw of [
      "not json at all",
      "null",
      "[]",
      JSON.stringify({ account: "acme", accountType: "User", connectedAt: 1 }),
      JSON.stringify({ ...link, installationId: "42" }),
      JSON.stringify({ ...link, installationId: -1 }),
      JSON.stringify({ ...link, installationId: 1.5 }),
      JSON.stringify({ ...link, account: "" }),
      JSON.stringify({ ...link, accountType: "Robot" }),
    ]) {
      await secrets.put(githubLinkSecretName("user-1"), raw);
      expect(await readGithubLink(secrets, "user-1")).toBeNull();
    }
  });

  test("a rewrite replaces the previous link", async () => {
    // Reconnecting to a different GitHub account must not leave the old
    // installation resolvable.
    const secrets = createMemorySecretStore();
    await writeGithubLink(secrets, "user-1", link);
    await writeGithubLink(secrets, "user-1", { ...link, installationId: 99, account: "other" });
    expect(await readGithubLink(secrets, "user-1")).toMatchObject({
      installationId: 99,
      account: "other",
    });
  });
});

describe("deleteGithubLink", () => {
  test("forgets the link", async () => {
    const secrets = createMemorySecretStore();
    await writeGithubLink(secrets, "user-1", link);
    await deleteGithubLink(secrets, "user-1");
    expect(await readGithubLink(secrets, "user-1")).toBeNull();
  });

  test("deleting a link that does not exist is not an error", async () => {
    // The route answers 200 either way — "not connected" is the state the
    // caller asked for, so the button must not fail when it has nothing to do.
    const secrets = createMemorySecretStore();
    await expect(deleteGithubLink(secrets, "user-1")).resolves.toBeUndefined();
  });
});
