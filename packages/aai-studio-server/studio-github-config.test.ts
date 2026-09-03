// Copyright 2026 the AAI authors. MIT license.
// The GitHub App's host configuration: what counts as configured, and the
// four shapes a PEM survives an environment variable in.

import { createPrivateKey, generateKeyPairSync } from "node:crypto";
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

  test("a PEM survives all four environment-variable spellings", () => {
    // Only the intact form signs a JWT, and the other three fail as
    // `DECODER routines::unsupported` at the first sync — hours after the
    // misconfiguration, nowhere near it.
    const intact = createGithubAppConfig(env({}));
    const escaped = createGithubAppConfig(
      env({ GITHUB_APP_PRIVATE_KEY: PEM.replaceAll("\n", "\\n") }),
    );
    const base64 = createGithubAppConfig(
      env({ GITHUB_APP_PRIVATE_KEY: Buffer.from(PEM, "utf8").toString("base64") }),
    );

    const spaced = createGithubAppConfig(
      env({ GITHUB_APP_PRIVATE_KEY: PEM.trim().replaceAll("\n", " ") }),
    );

    expect(intact?.privateKey).toContain("-----BEGIN PRIVATE KEY-----");
    expect(escaped?.privateKey).toBe(intact?.privateKey);
    expect(base64?.privateKey.trim()).toBe(PEM.trim());
    // The one that used to get PAST the header test: `includes("-----BEGIN")`
    // is true of a collapsed PEM, so it was returned unchanged and only
    // OpenSSL objected. Byte-identical to the intact form, because this value
    // is also the install `state` HMAC key.
    expect(spaced?.privateKey).toBe(intact?.privateKey);
  });

  test("a collapsed RSA key is one OpenSSL accepts, and the label is not split", () => {
    // The production shape, on a REAL key: 32 spaces, zero newlines, from a
    // paste through a single-line field. A whitespace substitution would
    // shatter `-----BEGIN RSA PRIVATE KEY-----` into four lines, which is why
    // the repair reads the header and footer rather than the spaces — and why
    // this asserts on `createPrivateKey` rather than on the string, the string
    // having looked fine throughout the outage.
    const pem = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    const collapsed = pem.trim().replaceAll("\n", " ");

    expect(collapsed).not.toContain("\n");
    expect(() => createPrivateKey(collapsed)).toThrow(/unsupported/);

    const config = createGithubAppConfig(env({ GITHUB_APP_PRIVATE_KEY: collapsed }));
    expect(config?.privateKey).toContain("-----BEGIN RSA PRIVATE KEY-----");
    expect(createPrivateKey(config?.privateKey ?? "").asymmetricKeyType).toBe("rsa");
    // Idempotent: an already-intact key is not re-shaped, or two replicas
    // reading the same secret through different paths would hold different
    // HMAC keys and reject each other's install callbacks.
    expect(config?.privateKey).toBe(pem.trim());
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
