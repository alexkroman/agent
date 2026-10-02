// Copyright 2025 the AAI authors. MIT license.
/**
 * Fixtures for the CLI integration specs that run commands against
 * {@link startMockApi}: one shared definition of the mock platform, the fake
 * terminal and the logged-in project, so `integration.test.ts` and
 * `integration-edge-cases.test.ts` cannot drift apart.
 */
import { updateGlobalConfig, writeProjectConfig } from "./_config.ts";
import { type MockApi, startMockApi } from "./_mock-api.ts";
import { test as baseTest, createFakeUi, type FakeUi } from "./_test-utils.ts";

/**
 * The package `test`, plus:
 *
 * - `api`: a fresh mock API server per test, stopped after it, with a REAL
 *   login key written to this run's config dir first (`_test-setup.ts` points
 *   `AAI_CONFIG_DIR` at a temp dir), so `ensureApiKey` runs unmocked.
 * - `ui`: a fresh {@link FakeUi} whose masked prompt answers a fixed value, so
 *   `secret put` with no stdin value has something to store.
 * - `projectDir`: a temp dir already linked to the `my-agent` slug on `api`.
 */
export const test = baseTest
  .extend("api", async ({ task: _task }, { onCleanup }): Promise<MockApi> => {
    await updateGlobalConfig((config) => ({ ...config, apiKey: "test-key" }));
    const api = await startMockApi();
    onCleanup(() => api.stop());
    return api;
  })
  .extend("ui", (): FakeUi => {
    const ui = createFakeUi();
    ui.prompts.password.mockResolvedValue("super-secret");
    return ui;
  })
  .extend("projectDir", async ({ tmpDir, api }) => {
    await writeProjectConfig(tmpDir, { slug: "my-agent", serverUrl: api.url });
    return tmpDir;
  });
