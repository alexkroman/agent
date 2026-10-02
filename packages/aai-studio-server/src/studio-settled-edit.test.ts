// Copyright 2026 the AAI authors. MIT license.
// What an edit made outside the coding agent's turn owes the studio
// (studio-settled-edit.ts): a live-session refresh and a preview deploy on
// the caller's behalf. Which routes call it is studio-routes.test.ts.

import { setImmediate } from "node:timers/promises";
import { captureLogs } from "aai-server/test-utils";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import { fakeBroker } from "./_studio-routes-test-utils.ts";
import type { StudioHonoEnv } from "./studio-context.ts";
import type { StudioSessionBroker } from "./studio-session-broker.ts";
import { onSettledEdit, previewOrigin } from "./studio-settled-edit.ts";

const ORIGIN = "https://aai.example";
const logs = captureLogs();

/**
 * Run `body` inside a real request carrying `apiKey` (and `userId` when
 * given), the way the auth middleware leaves the context.
 */
async function inRequest(
  vars: { apiKey: string; userId?: string },
  body: (c: Parameters<typeof onSettledEdit>[1]) => void,
): Promise<void> {
  const app = new Hono<StudioHonoEnv>();
  app.use(async (c, next) => {
    c.set("apiKey", vars.apiKey);
    if (vars.userId !== undefined) c.set("userId", vars.userId);
    await next();
  });
  app.put("/edit", (c) => {
    body(c);
    return c.json({ ok: true });
  });
  const res = await app.request("/edit", { method: "PUT" });
  if (res.status !== 200) throw new Error(`the route answered ${res.status}`);
}

function observedBroker(refresh: StudioSessionBroker["refreshSession"] = async () => true) {
  const refreshSession = vi.fn(refresh);
  const schedulePreview = vi.fn<StudioSessionBroker["schedulePreview"]>();
  return {
    broker: fakeBroker({ refreshSession, schedulePreview }),
    refreshSession,
    schedulePreview,
  };
}

describe("previewOrigin", () => {
  test("names the browser user, so a redelivered job can resolve their key", async () => {
    vi.stubEnv("AAI_PUBLIC_ORIGIN", ORIGIN);
    let origin: ReturnType<typeof previewOrigin> | undefined;
    await inRequest({ apiKey: "k", userId: "user-1" }, (c) => {
      origin = previewOrigin(c);
    });
    expect(origin).toEqual({ serverUrl: ORIGIN, userId: "user-1" });
  });

  test("a raw-key caller has no user, and the field is absent rather than undefined", async () => {
    vi.stubEnv("AAI_PUBLIC_ORIGIN", ORIGIN);
    let origin: ReturnType<typeof previewOrigin> | undefined;
    await inRequest({ apiKey: "k" }, (c) => {
      origin = previewOrigin(c);
    });
    expect(origin).toEqual({ serverUrl: ORIGIN });
    expect(origin).not.toHaveProperty("userId");
  });
});

describe("onSettledEdit", () => {
  test("refreshes the live session and schedules a preview, as the caller", async () => {
    vi.stubEnv("AAI_PUBLIC_ORIGIN", ORIGIN);
    const { broker, refreshSession, schedulePreview } = observedBroker();
    await inRequest({ apiKey: "caller-key", userId: "user-1" }, (c) => {
      onSettledEdit(broker, c, "scope", "proj");
    });
    expect(refreshSession).toHaveBeenCalledWith("scope", "proj", "caller-key");
    expect(schedulePreview).toHaveBeenCalledWith("scope", "proj", {
      serverUrl: ORIGIN,
      userId: "user-1",
      apiKey: "caller-key",
    });
  });

  test("a failed refresh is contained and the preview is still scheduled", async () => {
    // Off the response path: the workspace row is already durable.
    vi.stubEnv("AAI_PUBLIC_ORIGIN", ORIGIN);
    const { broker, schedulePreview } = observedBroker(async () => {
      throw new Error("peer unreachable");
    });
    await inRequest({ apiKey: "k" }, (c) => {
      onSettledEdit(broker, c, "scope", "proj");
    });
    // Let the refresh's rejection settle: an unhandled one fails the run.
    await setImmediate();
    expect(schedulePreview).toHaveBeenCalledTimes(1);
    expect(logs.warns()).toEqual([expect.stringContaining("live session refresh failed")]);
  });
});
