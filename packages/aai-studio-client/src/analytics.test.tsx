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
  sessions: { count: 0, medianDurationMs: null },
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
          sessions: { count: 12, medianDurationMs: 95_000 },
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

  test("renders the per-day bars and the recent-session table", async () => {
    // The two surfaces an author actually looks at first — "is traffic
    // growing" and "what happened in the last few calls" — and neither had a
    // test, so every cell renderer in SESSION_COLUMNS was unexercised.
    const startedAt = Date.UTC(2026, 7, 10, 14, 30);
    stubFetch({
      "/studio/projects/demo/analytics": () =>
        jsonResponse({
          ...EMPTY_SUMMARY,
          slugs: ["demo"],
          daily: [
            { day: "2026-08-09", sessions: 4, turns: 12, errors: 0 },
            { day: "2026-08-10", sessions: 8, turns: 30, errors: 1 },
          ],
          recentSessions: [
            {
              sessionId: "s-1",
              startedAt,
              durationMs: 95_000,
              turns: 6,
              errors: 1,
              endReason: "idle_timeout",
            },
          ],
        }),
    });
    renderPane();

    // One bar per day, labelled so the shape is readable without a tooltip.
    const bars = await screen.findByLabelText("Sessions per day");
    expect(bars.querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByTitle("2026-08-10: 8 sessions, 30 turns, 1 errors")).toBeTruthy();

    // The session row, through every SESSION_COLUMNS cell.
    expect(screen.getByText("idle_timeout")).toBeTruthy();
    expect(screen.getByText("1m 35s")).toBeTruthy();
  });

  test("a session that ended for no recorded reason renders a dash, not blank", async () => {
    stubFetch({
      "/studio/projects/demo/analytics": () =>
        jsonResponse({
          ...EMPTY_SUMMARY,
          slugs: ["demo"],
          recentSessions: [
            {
              sessionId: "s-2",
              startedAt: Date.now(),
              durationMs: null,
              turns: 0,
              errors: 0,
            },
          ],
        }),
    });
    renderPane();
    // Two dashes: the unknown length and the unknown end reason. An empty cell
    // reads as a rendering bug rather than as an absent value.
    await waitFor(() => expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2));
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
