// Copyright 2026 the AAI authors. MIT license.
import { afterEach, describe, expect, test } from "vitest";
import { makeAgent } from "../_agent-test-utils.ts";
import { silentLogger } from "../_logger-test-utils.ts";
import { createRuntime } from "../runtime/index.ts";
// A namespace import: this spec pins that the DEPRECATED name keeps working,
// which `noDeprecatedImports` exists to keep new code from relying on.
import * as renamed from "./server-renamed.ts";
import type { AgentServer } from "./types.ts";

describe("createRuntimeServer (deprecated name)", () => {
  let server: AgentServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  test("still serves the runtime it is handed, under the old name", async () => {
    const runtime = createRuntime({
      agent: makeAgent({ name: "Renamed" }),
      env: {},
      logger: silentLogger,
    });
    server = renamed.createRuntimeServer({ runtime, name: "Renamed", logger: silentLogger });
    await server.listen(0);
    const res = await fetch(`http://127.0.0.1:${server.port}/client-config`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({ name: "Renamed" });
  });
});
