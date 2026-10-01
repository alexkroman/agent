// Copyright 2026 the AAI authors. MIT license.
/**
 * The one ordering decision behind the run journal, the key index and the upload
 * record: platform, then the agent's database, then local.
 *
 * Asserted HERE once rather than per store, because the stores no longer decide it:
 * `selectJournal`, `selectKeyStore` and `createUploadStore` each take the home this
 * returns. `runtime.test.ts` and `install.test.ts` still check that each store
 * honours the home through what it logs and does.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { isDurableHome, resolveStorageHome } from "./storage-home.ts";

/**
 * The home is generic over what stands for the database (an open `Db` for the
 * stores, its URL for `ownedSchemaUrl`), so a URL is a faithful stand-in here.
 */
const db = "postgres://app@127.0.0.1:5432/app";

afterEach(() => {
  vi.unstubAllEnvs();
});

function stubPlatform(): void {
  vi.stubEnv("AAI_PLATFORM_BASE_URL", "https://platform.test/digest-desk");
  vi.stubEnv("AAI_GUEST_TOKEN", "sandbox-token");
}

describe("resolveStorageHome", () => {
  test("a platform guest's home is the platform, even beside an author's database", () => {
    stubPlatform();
    const home = resolveStorageHome(db);
    expect(home).toMatchObject({
      kind: "platform",
      platform: { base: "https://platform.test/digest-desk", token: "sandbox-token" },
    });
    expect(isDurableHome(home)).toBe(true);
  });

  test("with no platform, the agent's own database", () => {
    vi.stubEnv("AAI_PLATFORM_BASE_URL", "");
    vi.stubEnv("AAI_PUBLIC_BASE_URL", "");
    vi.stubEnv("AAI_GUEST_TOKEN", "");
    const home = resolveStorageHome(db);
    expect(home).toEqual({ kind: "postgres", db });
    expect(isDurableHome(home)).toBe(true);
  });

  test("with neither, local — and local is the one home that is not durable", () => {
    vi.stubEnv("AAI_PLATFORM_BASE_URL", "");
    vi.stubEnv("AAI_PUBLIC_BASE_URL", "");
    vi.stubEnv("AAI_GUEST_TOKEN", "");
    const home = resolveStorageHome(undefined);
    expect(home).toEqual({ kind: "local" });
    expect(isDurableHome(home)).toBe(false);
  });

  test("a half-configured pair is NOT a platform: the token alone resolves nothing", () => {
    // The pair is the platform's statement about the sandbox it spawned; one half of
    // it is a deployment fault (`describePlatformQueueGap` reports it), never a home.
    vi.stubEnv("AAI_PLATFORM_BASE_URL", "");
    vi.stubEnv("AAI_PUBLIC_BASE_URL", "");
    vi.stubEnv("AAI_GUEST_TOKEN", "sandbox-token");
    expect(resolveStorageHome(db).kind).toBe("postgres");
  });
});
