// Copyright 2026 the AAI authors. MIT license.
// The GitHub App's host configuration: what counts as configured, and the
// three shapes a PEM survives an environment variable in.

import { describe, expect, test } from "vitest";
import { createGithubAppConfig, githubInstallUrl } from "./studio-github-config.ts";

const PEM = "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADAN\n-----END PRIVATE KEY-----\n";

const env = (overrides: Record<string, string | undefined>): NodeJS.ProcessEnv => ({
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: PEM,
  GITHUB_APP_SLUG: "aai-studio",
  GITHUB_APP_CLIENT_ID: "Iv1.abc",
  GITHUB_APP_CLIENT_SECRET: "shhh",
  ...overrides,
});

describe("createGithubAppConfig", () => {
  test("every variable, or nothing", () => {
    expect(createGithubAppConfig(env({}))).toMatchObject({
      appId: "123456",
      slug: "aai-studio",
    });
    // A half-configured App is the state where the install link works and
    // every sync fails, so it reads as "not configured" rather than as a
    // partially usable feature. The OAuth pair is sharper still: without it
    // the callback cannot check entitlement at all, so a deployment missing it
    // is not a degraded feature but an OPEN one.
    for (const missing of [
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_APP_SLUG",
      "GITHUB_APP_CLIENT_ID",
      "GITHUB_APP_CLIENT_SECRET",
    ]) {
      expect(createGithubAppConfig(env({ [missing]: undefined }))).toBeUndefined();
    }
    expect(createGithubAppConfig({})).toBeUndefined();
  });

  test("an empty string is not configuration", () => {
    // `GITHUB_APP_SLUG=` in a .env file is a variable that exists and says
    // nothing; treating it as set builds `github.com/apps//installations/new`.
    expect(createGithubAppConfig(env({ GITHUB_APP_SLUG: "" }))).toBeUndefined();
  });

  test("a PEM survives all three environment-variable spellings", () => {
    // Only the intact form signs a JWT, and the other two fail as
    // `DECODER routines::unsupported` at the first sync — hours after the
    // misconfiguration, nowhere near it.
    const intact = createGithubAppConfig(env({}));
    const escaped = createGithubAppConfig(
      env({ GITHUB_APP_PRIVATE_KEY: PEM.replaceAll("\n", "\\n") }),
    );
    const base64 = createGithubAppConfig(
      env({ GITHUB_APP_PRIVATE_KEY: Buffer.from(PEM, "utf8").toString("base64") }),
    );

    expect(intact?.privateKey).toContain("-----BEGIN PRIVATE KEY-----");
    expect(escaped?.privateKey).toBe(intact?.privateKey);
    expect(base64?.privateKey.trim()).toBe(PEM.trim());
  });

  test("something that decodes to no PEM at all is left alone", () => {
    // The honest report for an unrecognizable key is OpenSSL's, at the point
    // of use — never a truncated guess from a base64 decode that happened to
    // produce bytes.
    const config = createGithubAppConfig(env({ GITHUB_APP_PRIVATE_KEY: "not-a-key" }));
    expect(config?.privateKey).toBe("not-a-key");
  });
});

describe("githubInstallUrl", () => {
  test("points at the App's install page and carries the state", () => {
    const config = createGithubAppConfig(env({}));
    if (!config) throw new Error("expected a config");
    const url = new URL(githubInstallUrl(config, "signed.state"));

    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe("/apps/aai-studio/installations/new");
    expect(url.searchParams.get("state")).toBe("signed.state");
  });

  test("the state is URL-encoded rather than concatenated", () => {
    // A signed state is base64url plus a dot, so nothing in it needs escaping
    // today — building the URL through `URLSearchParams` is what keeps that
    // from being a property of the signing format.
    const config = createGithubAppConfig(env({}));
    if (!config) throw new Error("expected a config");
    const url = new URL(githubInstallUrl(config, "a b&c=d"));
    expect(url.searchParams.get("state")).toBe("a b&c=d");
  });
});
