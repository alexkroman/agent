// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the one-client-per-agent factory.
 *
 * Two things are worth pinning and nothing else here is: that the front-door
 * read lands on the agent's `client-config` path however the base URL was
 * spelled (a trailing slash is what produces the `//client-config` a platform
 * routing `/:slug/client-config` answers 404), and that the workflow half is the
 * SAME client rather than a re-implementation — the property that makes this a
 * superset instead of a second design to keep in step.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { createAgentClient } from "./agent-client.ts";
import { createWorkflowApiClient } from "./workflow-api-client.ts";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ name: "Demo", page: "static" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

describe("createAgentClient", () => {
  test("reads client-config off the agent's base URL", async () => {
    const agent = createAgentClient({ baseUrl: "https://agents.example/demo" });
    await expect(agent.config()).resolves.toEqual({ name: "Demo", page: "static" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://agents.example/demo/client-config");
  });

  test("a trailing slash does not become a double one", async () => {
    const agent = createAgentClient({ baseUrl: "https://agents.example/demo/" });
    await agent.config();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://agents.example/demo/client-config");
    expect(agent.baseUrl).toBe("https://agents.example/demo");
  });

  test("sends the bearer when there is one, though the route does not require it", async () => {
    await createAgentClient({ baseUrl: "https://agents.example/demo", token: "t0" }).config();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.headers).toEqual({ Authorization: "Bearer t0" });
  });

  test("a refused read carries the agent's own sentence", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: "Agent demo is not deployed" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(
      createAgentClient({ baseUrl: "https://agents.example/demo" }).config(),
    ).rejects.toThrow(/not deployed/);
  });

  test("carries the WHOLE workflow surface, so a caller needs one client", () => {
    // A subset is the failure this shape exists to prevent — every one of the
    // three hand-written clients the SDK replaced was one.
    const agent = createAgentClient({ baseUrl: "https://agents.example/demo" });
    const workflows = createWorkflowApiClient({ baseUrl: "https://agents.example/demo" });
    expect(Object.keys(agent).sort()).toEqual(
      [...Object.keys(workflows), "baseUrl", "config"].sort(),
    );
  });
});
