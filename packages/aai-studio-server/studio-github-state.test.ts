// Copyright 2026 the AAI authors. MIT license.
// The signed `state` that carries a studio user across the GitHub install
// redirect.
//
// This is the whole authentication of `GET /studio/github/callback` — a route
// that structurally cannot have a bearer — so the negative cases are the point
// of the suite: unsigned, wrongly signed, tampered, expired, and signed by a
// DIFFERENT App must every one of them fail closed.

import { describe, expect, test } from "vitest";
import { testGithubApp } from "./_studio-github-test-utils.ts";
import type { GithubAppConfig } from "./studio-github-config.ts";
import {
  INSTALL_STATE_TTL_MS,
  signInstallState,
  verifyInstallState,
} from "./studio-github-state.ts";

const otherApp: GithubAppConfig = { ...testGithubApp, privateKey: `${testGithubApp.privateKey} ` };

describe("signInstallState / verifyInstallState", () => {
  test("round-trips the uid and the project hint", () => {
    const state = signInstallState(testGithubApp, { uid: "user-1", project: "demo" });
    expect(verifyInstallState(testGithubApp, state)).toMatchObject({
      uid: "user-1",
      project: "demo",
    });
  });

  test("an absent project stays absent rather than becoming undefined", () => {
    const state = signInstallState(testGithubApp, { uid: "user-1" });
    const claims = verifyInstallState(testGithubApp, state);
    expect(claims?.uid).toBe("user-1");
    expect(claims && "project" in claims).toBe(false);
  });

  test("a forged state naming another user is refused", () => {
    // The attack the signature exists for: without it, `?state=` is an
    // attacker-supplied user id and the callback attaches THEIR GitHub
    // installation to somebody else's studio account.
    const forged = `${Buffer.from(JSON.stringify({ uid: "victim", exp: Date.now() + 60_000 }))
      .toString("base64url")
      .replace(/=+$/, "")}.notasignature`;
    expect(verifyInstallState(testGithubApp, forged)).toBeNull();
  });

  test("a tampered payload invalidates the signature", () => {
    const state = signInstallState(testGithubApp, { uid: "user-1" });
    const [, signature] = state.split(".");
    const swapped = Buffer.from(JSON.stringify({ uid: "victim", exp: Date.now() + 60_000 }))
      .toString("base64url")
      .replace(/=+$/, "");
    expect(verifyInstallState(testGithubApp, `${swapped}.${signature}`)).toBeNull();
  });

  test("a state signed by a different App key is refused", () => {
    // The HMAC key is DERIVED from the App's private key, so this is also the
    // test that the derivation really depends on it.
    const state = signInstallState(otherApp, { uid: "user-1" });
    expect(verifyInstallState(testGithubApp, state)).toBeNull();
  });

  test("expiry is enforced, at the boundary", () => {
    const now = 1_000_000;
    const state = signInstallState(testGithubApp, { uid: "user-1" }, now);
    // Live right up to `exp`, gone after it — a captured state is a bearer for
    // one linking action and this is the only thing bounding it.
    expect(verifyInstallState(testGithubApp, state, now + INSTALL_STATE_TTL_MS - 1)).not.toBeNull();
    expect(verifyInstallState(testGithubApp, state, now + INSTALL_STATE_TTL_MS)).toBeNull();
    expect(verifyInstallState(testGithubApp, state, now + INSTALL_STATE_TTL_MS + 1)).toBeNull();
  });

  test("malformed shapes are refused rather than thrown on", () => {
    // The input is a query parameter, so every one of these is reachable by
    // anyone who can type a URL — a throw here is a 500 on a public route.
    for (const bad of [
      "",
      ".",
      "onlyonepart",
      "a.b.c",
      "..",
      `${Buffer.from("not json").toString("base64url")}.sig`,
    ]) {
      expect(verifyInstallState(testGithubApp, bad)).toBeNull();
    }
  });

  test("a correctly-signed payload that is not an install state is refused", () => {
    // Signature valid, claims wrong: the schema is what stops a signed blob
    // from some other use of this key being read as a uid. An empty uid is not
    // identity, and `InstallStateSchema` is the ONLY thing that can reject this
    // — the module signed it itself, so the signature check cannot.
    //
    // Letting the module sign it is also what makes the case deterministic.
    // Hand-building the payload and splicing it into a real state called
    // `signInstallState` TWICE, each defaulting `now` to its own `Date.now()`:
    // when the millisecond ticked between them the two payloads differed, the
    // `replace` matched nothing, and the "bad" state was a perfectly valid one
    // that verified — which is exactly how this failed in CI and passed on
    // every machine fast enough to sign twice inside one millisecond. And when
    // the splice DID land it swapped the payload while keeping a signature over
    // the original, so what rejected it was the signature rather than the
    // schema: the assertion held with `InstallStateSchema` deleted.
    const badState = signInstallState(testGithubApp, { uid: "" });
    expect(verifyInstallState(testGithubApp, badState)).toBeNull();
  });
});
