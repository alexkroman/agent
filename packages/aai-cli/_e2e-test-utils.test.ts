// Copyright 2026 the AAI authors. MIT license.
/**
 * The e2e harness spawns the REAL CLI as a child process, so machine
 * isolation has to be carried in the child's environment — the in-process
 * guards (`getConfigDir`'s VITEST fallback, `_test-setup.ts`) cannot reach
 * it. These tests pin that, and they deliberately live in a `_`-prefixed
 * file so they run in the normal suite rather than only under the e2e
 * profile (`VITEST_INCLUDE=e2e*.test.ts`), which is the run that lacked the
 * isolation in the first place.
 */

import envPaths from "env-paths";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { aaiEnv } from "./_e2e-test-utils.ts";

describe("aaiEnv", () => {
  // `aaiEnv()` spreads `process.env`, and this suite's own setup file already
  // sets AAI_CONFIG_DIR — which would make these pass without `aaiEnv()`
  // contributing anything. Clear it so what's under test is `aaiEnv()`'s OWN
  // guarantee, which is what the e2e profile (no setup file) relies on.
  beforeEach(() => {
    vi.stubEnv("AAI_CONFIG_DIR", "");
  });

  test("points the spawned CLI at a throwaway config dir", () => {
    // Without this, every `--server http://127.0.0.1:<port>` an e2e run
    // passes is recorded in the developer's real config as a permanently
    // approved origin (`approveServer`). Approved loopback origins are
    // exactly what `resolveServerUrl` refuses to trust from a repo, so
    // pre-approving them hands a cloned repo the developer's API key.
    const dir = aaiEnv().AAI_CONFIG_DIR;
    expect(dir).toBeTruthy();
    expect(dir).not.toBe(envPaths("aai", { suffix: "" }).config);
  });

  test("the child's config dir is stable across calls in one run", () => {
    // `aai()` builds a fresh env per invocation; a new dir each time would
    // lose the API key written by an earlier step of the same scenario.
    expect(aaiEnv().AAI_CONFIG_DIR).toBe(aaiEnv().AAI_CONFIG_DIR);
  });

  test("clears VITEST so the spawned CLI actually runs its main()", () => {
    // Guards the reason the in-process VITEST fallback cannot cover children.
    expect(aaiEnv().VITEST).toBeUndefined();
  });
});
