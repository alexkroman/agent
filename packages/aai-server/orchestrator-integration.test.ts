// Copyright 2025 the AAI authors. MIT license.
/**
 * Integration tests for the orchestrator HTTP layer.
 *
 * Uses real `createBundleStore` + unstorage memory driver (not the mock)
 * to verify that deployed agent bundles are correctly served by the
 * orchestrator. No sandbox / VM required.
 */

import { describe, expect, test } from "vitest";
import { TEST_AGENT_CONFIG } from "./test-utils.ts";

async function createRealOrchestrator() {
  const { createStorage } = await import("unstorage");
  const { createBundleStore } = await import("./bundle-store.ts");
  const { importMasterKey } = await import("./secrets.ts");
  const { createOrchestrator } = await import("./orchestrator.ts");

  const storage = createStorage();
  const masterKey = await importMasterKey("test-secret");
  const store = createBundleStore(storage, { masterKey });
  const { createSlotCache } = await import("./sandbox-slots.ts");
  const { app } = createOrchestrator({ slots: createSlotCache(), store, storage });
  const fetch = async (input: string | Request, init?: RequestInit) => app.request(input, init);
  return { fetch, store };
}

describe("deploy serves client files", () => {
  test("deploy → GET / returns HTML, GET /assets/* returns JS", async () => {
    const { fetch, store } = await createRealOrchestrator();

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
      agentConfig: TEST_AGENT_CONFIG,
    });

    const htmlRes = await fetch("/rt-agent/");
    expect(htmlRes.status).toBe(200);
    const html = await htmlRes.text();
    expect(html).toContain("<!DOCTYPE html>");

    const jsRes = await fetch("/rt-agent/assets/index.js");
    expect(jsRes.status).toBe(200);
    const js = await jsRes.text();
    expect(js).toContain("console.log");
  });

  test("redeploy updates served HTML", async () => {
    const { fetch, store } = await createRealOrchestrator();

    await store.putAgent({
      slug: "update-agent",
      env: {},
      worker: "w",
      clientFiles: { "index.html": "<!DOCTYPE html><html>v1</html>" },
      credential_hashes: ["h"],
      agentConfig: TEST_AGENT_CONFIG,
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
      agentConfig: TEST_AGENT_CONFIG,
    });

    const v2 = await fetch("/update-agent/");
    expect(v2.status).toBe(200);
    expect(await v2.text()).toContain("v2");
  });
});
