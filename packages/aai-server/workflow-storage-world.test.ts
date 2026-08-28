// Copyright 2026 the AAI authors. MIT license.
/**
 * The gate under the workflow world: that something actually BUILDS it.
 *
 * `createPlatformWorldStorage` shipped with no caller anywhere outside a test
 * util. Nothing caught it, and nothing could have: the binding it fills
 * (`OrchestratorOpts.runStorage`) is optional, the routes that need it answer a
 * deliberate 501 when it is absent, and every suite that exercises those routes
 * injects its own fake world — so the whole feature was green in this package
 * while being dead in production. The guest side had gone live in the same
 * range: a deployed sandbox always carries `AAI_PUBLIC_BASE_URL` and
 * `AAI_GUEST_TOKEN`, so `configureWorkflowWorld` always chose `"platform"` and
 * every durable run failed at its first `events.create`.
 *
 * A TEXT scan, for the reason `store-conformance-registry.test.ts` gives: this
 * is a claim about which files reference a symbol, not about behaviour any
 * import of this module could observe. Importing `service-config.ts` and calling
 * it is not the alternative — `buildServiceConfig` on the platform tier requires
 * a Supabase credential set, opens pools, and fires boot-time queries, none of
 * which belongs in the unit tier.
 *
 * What this cannot check is that the value REACHES the routes; that is
 * `workflow-storage-handler.test.ts` and `workflow-stream-handler.test.ts`,
 * which drive a real orchestrator with a world injected the same way
 * `buildServiceConfig` now injects one.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const PACKAGE = import.meta.dirname;

/**
 * This package's SHIPPED modules — no specs, and no test utilities.
 *
 * The exclusion is the whole point. `_workflow-storage-test-utils.ts` passes a
 * fake world to `createTestOrchestrator`, so a scan that counted it would report
 * the dead symbol as wired, which is precisely the false green this file exists
 * to prevent.
 */
function shippedSources(): { name: string; text: string }[] {
  return readdirSync(PACKAGE, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .filter((e) => !(e.name.endsWith(".test.ts") || e.name.includes("test-utils")))
    .map((e) => ({ name: e.name, text: readFileSync(path.join(PACKAGE, e.name), "utf8") }));
}

describe("the platform workflow world is composed, not merely defined", () => {
  test("something other than its own module calls createPlatformWorldStorage", () => {
    const callers = shippedSources()
      .filter((f) => f.name !== "workflow-storage-world.ts")
      .filter((f) => f.text.includes("createPlatformWorldStorage"))
      .map((f) => f.name);
    // Named rather than counted, so a failure says which file lost the call.
    expect(callers).toContain("service-config.ts");
  });

  test("buildServiceConfig hands the world on as `runStorage`", () => {
    // Constructing it and dropping it on the floor is the same outage with an
    // extra pool: the routes read `opts.runStorage` and nothing else.
    const config = readFileSync(path.join(PACKAGE, "service-config.ts"), "utf8");
    expect(config).toMatch(/omitUndefined\(\{\s*runStorage\s*\}\)/);
  });

  test("the world is built off the DIRECT url, never the transaction pooler", () => {
    // Their streamer holds a dedicated `LISTEN` client, which needs session
    // affinity exactly as an advisory lock does — and
    // `platformDbConnectionsPerReplica` counts this pool as DIRECT on that
    // basis. Handing it `PLATFORM_POOLER_URL` would make the budget wrong AND
    // the subscription silently undeliverable.
    const config = readFileSync(path.join(PACKAGE, "service-config.ts"), "utf8");
    expect(config).toMatch(/createPlatformWorldStorage\(\{\s*url:\s*env\.SUPABASE_DB_URL\s*\}\)/);
    expect(config).not.toMatch(/createPlatformWorldStorage\([^)]*POOLER/);
  });

  test("the composition root closes it on shutdown", () => {
    // The pool and the streamer's LISTEN client are this process's to release;
    // `close()` had no caller either, for the same reason the constructor had
    // none.
    const entry = readFileSync(
      path.resolve(PACKAGE, "..", "aai-studio-server", "index.ts"),
      "utf8",
    );
    expect(entry).toMatch(/runStorage\?\.close\(\)/);
  });
});
