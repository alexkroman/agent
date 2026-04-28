// Copyright 2025 the AAI authors. MIT license.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("push-dashboards", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.GRAFANA_TOKEN = "test-token";
    vi.resetModules();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.GRAFANA_TOKEN;
  });

  it("--dry-run does not call fetch", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    process.argv = ["node", "push-dashboards.ts", "--dry-run"];
    await import("./push-dashboards.ts");
    // Allow any pending microtasks (the script is top-level await)
    await new Promise((r) => setImmediate(r));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts folder + each dashboard with overwrite=true and folderUid set", async () => {
    const fetchSpy = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ url: "/d/aai-overview/x" }),
          text: async () => "",
        }) as unknown as Response,
    );
    globalThis.fetch = fetchSpy as typeof fetch;
    process.argv = ["node", "push-dashboards.ts"];
    await import("./push-dashboards.ts");
    await vi.waitFor(() => {
      const dashboardCalls = fetchSpy.mock.calls.filter(([url]) =>
        String(url).includes("/api/dashboards/db"),
      );
      expect(dashboardCalls.length).toBe(4);
    });

    const dashboardCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes("/api/dashboards/db"),
    );
    expect(dashboardCalls.length).toBe(4);
    for (const [, init] of dashboardCalls) {
      const body = JSON.parse(String(init?.body));
      expect(body.overwrite).toBe(true);
      expect(body.folderUid).toBe("aai-agent");
    }
  });
});
