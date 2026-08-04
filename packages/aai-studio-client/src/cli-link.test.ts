// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
import { afterEach, describe, expect, test } from "vitest";
import { clearCliLinkCode, consumeCliLinkCode, linkConfirmationCode } from "./cli-link.ts";

const CODE = "abcDEF12_-345678901234567890123456789012345";

afterEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("consumeCliLinkCode", () => {
  test("stashes a fresh CLI-opened code and strips it from the URL", () => {
    window.history.replaceState(null, "", `/?cli-link=${CODE}&other=1`);
    expect(consumeCliLinkCode()).toBe(CODE);
    // The code must not survive in the URL — it would otherwise ride the
    // OAuth redirect chain through Supabase and GitHub.
    expect(window.location.search).toBe("?other=1");
    expect(sessionStorage.getItem("aai-studio-cli-link")).toBe(CODE);
  });

  test("restores the stashed code when the OAuth redirect lands on a bare URL", () => {
    sessionStorage.setItem("aai-studio-cli-link", CODE);
    expect(consumeCliLinkCode()).toBe(CODE);
  });

  test("rejects codes outside the server grammar, from URL and stash alike", () => {
    window.history.replaceState(null, "", "/?cli-link=too-short");
    expect(consumeCliLinkCode()).toBeNull();
    window.history.replaceState(null, "", "/");
    sessionStorage.setItem("aai-studio-cli-link", "bad$chars".repeat(8));
    expect(consumeCliLinkCode()).toBeNull();
  });

  test("returns null when there is no code anywhere", () => {
    expect(consumeCliLinkCode()).toBeNull();
  });
});

describe("clearCliLinkCode", () => {
  test("drops the stash and any surviving URL param", () => {
    window.history.replaceState(null, "", `/?cli-link=${CODE}`);
    sessionStorage.setItem("aai-studio-cli-link", CODE);
    clearCliLinkCode();
    expect(sessionStorage.getItem("aai-studio-cli-link")).toBeNull();
    expect(window.location.search).toBe("");
  });
});

describe("linkConfirmationCode", () => {
  // The exact fixture is mirrored in aai-cli's login.test.ts — the CLI
  // prints this value and this gate displays it, so the two derivations
  // must never drift.
  test("matches the CLI's derivation: first 8 chars, uppercased, hyphenated", () => {
    expect(linkConfirmationCode(CODE)).toBe("ABCD-EF12");
    expect(linkConfirmationCode("zzzzyyyy-rest-ignored-0000000000000000000")).toBe("ZZZZ-YYYY");
  });
});
