// Copyright 2025 the AAI authors. MIT license.
/**
 * The orchestrator serves a deployed agent's own client files: `GET /:slug/`
 * returns its HTML, `GET /:slug/assets/*` returns its assets, and a redeploy
 * replaces both.
 *
 * Over the REAL `createBundleStore` on in-memory blob storage rather than a
 * mocked store, so the content-addressed blob + row-commit path is the one
 * under test. No sandbox, no VM.
 *
 * This was `orchestrator.scenario.test.ts`, whose docstring claimed "a real
 * HTTP server on a real port, which is what puts them in that tier". It binds
 * nothing — the body is in-memory `app.request(...)` — so it sat outside
 * `pnpm test` and outside the package's measured coverage for a property the
 * membership rule does not recognise. Tiers are cut by what a test TOUCHES
 * (AGENTS.md, "Test tiers"), and this touches memory.
 */

import { describe, expect, test } from "vitest";
import { createTestOrchestrator } from "./test-utils.ts";

describe("deploy serves client files", () => {
  test("deploy → GET / returns HTML, GET /assets/* returns JS", async () => {
    const { fetch, store } = await createTestOrchestrator();

    await store.putAgent({
      slug: "rt-agent",
      env: {},
      worker: "w",
      clientFiles: {
        "index.html":
          '<!DOCTYPE html><html><body><script src="./assets/index.js"></script></body></html>',
        "assets/index.js": 'console.log("app");',
      },
      credential_hashes: ["h"],
    });

    const htmlRes = await fetch("/rt-agent/");
    expect(htmlRes.status).toBe(200);
    expect(await htmlRes.text()).toContain("<!DOCTYPE html>");

    const jsRes = await fetch("/rt-agent/assets/index.js");
    expect(jsRes.status).toBe(200);
    expect(await jsRes.text()).toContain("console.log");
  });

  test("redeploy updates served HTML", async () => {
    const { fetch, store } = await createTestOrchestrator();

    await store.putAgent({
      slug: "update-agent",
      env: {},
      worker: "w",
      clientFiles: { "index.html": "<!DOCTYPE html><html>v1</html>" },
      credential_hashes: ["h"],
    });

    const v1 = await fetch("/update-agent/");
    expect(v1.status).toBe(200);
    expect(await v1.text()).toContain("v1");

    await store.putAgent({
      slug: "update-agent",
      env: {},
      worker: "w",
      clientFiles: { "index.html": "<!DOCTYPE html><html>v2</html>" },
      credential_hashes: ["h"],
    });

    const v2 = await fetch("/update-agent/");
    expect(v2.status).toBe(200);
    expect(await v2.text()).toContain("v2");
  });
});
