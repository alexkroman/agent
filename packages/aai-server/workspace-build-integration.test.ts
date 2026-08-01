// Copyright 2026 the AAI authors. MIT license.
/**
 * Integration: the guest's `workspace/build` — a REAL harness process
 * building a workspace through the aai CLI's own bundlers (the toolchain
 * resolved from the node_modules next to the harness) and loading the
 * built worker in place for its config self-description.
 *
 * This is THE studio build path (there is no host-side build anymore), so
 * this test is what keeps "studio builds" and "aai deploy builds" one
 * constantly-exercised pass.
 */

import { describe, expect, test } from "vitest";
import { resolveHarnessPath } from "./constants.ts";
import { registerGuestRpcHandlers } from "./sandbox-guest-rpc.ts";
import { spawnSubprocessWarm } from "./subprocess-sandbox.ts";

const AGENT_TS = `import { agent } from "@alexkroman1/aai";

export default agent({
  name: "integration-build",
  systemPrompt: "You are a test agent.",
  greeting: "Hello.",
});
`;

type BuildResult = {
  worker?: string;
  clientFiles?: Record<string, string>;
  config?: unknown;
  buildError?: string;
};

describe("guest workspace/build", () => {
  test("builds a workspace in the guest and self-describes the config", {
    timeout: 300_000,
  }, async () => {
    const warm = await spawnSubprocessWarm({
      harnessPath: resolveHarnessPath(),
      slug: "it-workspace-build",
    });
    try {
      registerGuestRpcHandlers(warm.conn, {});
      warm.conn.listen();
      const result = (await warm.conn.sendRequest(
        "workspace/build",
        { files: { "agent.ts": AGENT_TS }, worker: true, client: true },
        240_000,
      )) as BuildResult;

      expect(result.buildError).toBeUndefined();
      // The worker ships its own runtime — the factory export is present.
      expect(result.worker).toContain("__aaiCreateRuntime");
      // No client.tsx → no client files → published agents get the default UI.
      expect(result.clientFiles).toEqual({});
      // Loaded in place: the config the host's Publish validates rode back.
      expect(result.config).toMatchObject({
        name: "integration-build",
        greeting: "Hello.",
      });
    } finally {
      await warm[Symbol.asyncDispose]();
    }
  });

  test("reports compile errors as buildError prose (agent-actionable)", {
    timeout: 300_000,
  }, async () => {
    const warm = await spawnSubprocessWarm({
      harnessPath: resolveHarnessPath(),
      slug: "it-workspace-build-err",
    });
    try {
      registerGuestRpcHandlers(warm.conn, {});
      warm.conn.listen();
      const result = (await warm.conn.sendRequest(
        "workspace/build",
        { files: { "agent.ts": "const nope = {" }, worker: true, client: false },
        240_000,
      )) as BuildResult;
      expect(result.worker).toBeUndefined();
      expect(result.buildError).toContain("Build failed");
    } finally {
      await warm[Symbol.asyncDispose]();
    }
  });
});
