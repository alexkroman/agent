// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The Analytics pane. The behaviour worth pinning is the pair of states that
// must never look alike — a deployment with analytics switched off, and an
// agent nobody has called — plus the fact that the headline number is time to
// FIRST AUDIO rather than turn duration.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { jsonResponse, stubFetch } from "./_test-utils.ts";
import { AnalyticsPane } from "./analytics.tsx";

const EMPTY_SUMMARY = {
  windowDays: 7,
  sampled: false,
  slugs: [] as string[],
  sessions: { count: 0, medianDurationMs: null, totalTurns: 0 },
  turns: { count: 0, interrupted: 0, p50FirstAudioMs: null, p95FirstAudioMs: null },
  tools: [],
  errors: [],
  daily: [],
  recentSessions: [],
  logs: [],
};

function renderPane() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AnalyticsPane bearer="sk-test" project="demo" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("Analytics pane", () => {
  test("reads the project's analytics route", async () => {
    const fetchMock = stubFetch({
      "/studio/projects/demo/analytics": () => jsonResponse(EMPTY_SUMMARY),
    });
    renderPane();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/studio/projects/demo/analytics");
  });

  test("a disabled deployment says so instead of showing zeroes", async () => {
    // Zeroes here would tell a user their agent has no users.
    stubFetch({
      "/studio/projects/demo/analytics": () =>
        jsonResponse({
          ...EMPTY_SUMMARY,
          unavailable: "Analytics is not enabled on this deployment.",
        }),
    });
    renderPane();
    expect(await screen.findByText(/not enabled on this deployment/i)).toBeTruthy();
    expect(screen.queryByText("Sessions")).toBeNull();
  });

  test("a project with no deployed agent explains what it is waiting for", async () => {
    stubFetch({ "/studio/projects/demo/analytics": () => jsonResponse(EMPTY_SUMMARY) });
    renderPane();
    expect(await screen.findByText(/No deployed agent yet/i)).toBeTruthy();
  });

  test("headlines time to first audio, not turn duration", async () => {
    stubFetch({
      "/studio/projects/demo/analytics": () =>
        jsonResponse({
          ...EMPTY_SUMMARY,
          slugs: ["demo", "demo-preview"],
          sessions: { count: 12, medianDurationMs: 95_000, totalTurns: 40 },
          turns: { count: 40, interrupted: 3, p50FirstAudioMs: 420, p95FirstAudioMs: 1800 },
        }),
    });
    renderPane();
    expect(await screen.findByText("420 ms")).toBeTruthy();
    expect(screen.getByText("1.8 s")).toBeTruthy();
    expect(screen.getByText("caller stops → first audio")).toBeTruthy();
    expect(screen.getByText("1m 35s")).toBeTruthy();
    expect(screen.getByText("3 of 40 interrupted")).toBeTruthy();
  });

  test("renders tool reliability and the log tail", async () => {
    stubFetch({
      "/studio/projects/demo/analytics": () =>
        jsonResponse({
          ...EMPTY_SUMMARY,
          slugs: ["demo"],
          tools: [{ name: "check_stock", calls: 9, errors: 2, p50Ms: 40, p95Ms: 300 }],
          errors: [{ name: "tool", count: 2 }],
          logs: [{ ts: Date.now(), sessionId: "s1", level: "warn", message: "slow reply" }],
        }),
    });
    renderPane();
    expect(await screen.findByText("check_stock")).toBeTruthy();
    expect(screen.getByText("slow reply")).toBeTruthy();
    expect(screen.getByText("tool")).toBeTruthy();
  });

  test("surfaces a failed read", async () => {
    stubFetch({
      "/studio/projects/demo/analytics": () =>
        new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    });
    renderPane();
    expect(await screen.findByText(/boom/)).toBeTruthy();
  });

  test("warns when the numbers describe a sample rather than the window", async () => {
    stubFetch({
      "/studio/projects/demo/analytics": () =>
        jsonResponse({ ...EMPTY_SUMMARY, slugs: ["demo"], sampled: true }),
    });
    renderPane();
    expect(await screen.findByText(/more events than one view can read/i)).toBeTruthy();
  });
});
