// Copyright 2026 the AAI authors. MIT license.
/**
 * The session scope: `"session"` and an absent start key mean the session id,
 * an explicit key is left alone, and `withNotify` applies it with or without
 * a notifier.
 */

import { createStubWorkflows } from "@alexkroman1/aai/testing";
import { describe, expect, test, vi } from "vitest";
import { forSession } from "./client-session.ts";
import { withNotify } from "./notify.ts";

function spied() {
  const start = vi.fn(async () => "wrun_1");
  const find = vi.fn(async () => []);
  const latest = vi.fn(async () => undefined);
  const live = vi.fn(async () => undefined);
  const findByKey = vi.fn(async () => []);
  const cancelAll = vi.fn(async () => 0);
  const signalRun = vi.fn(async () => true);
  const inner = createStubWorkflows({ start, find, latest, live, findByKey, cancelAll, signalRun });
  return { inner, start, find, latest, live, findByKey, cancelAll, signalRun };
}

describe("forSession", () => {
  test("a start with no key, or the `session` literal, is keyed by the session", async () => {
    const { inner, start } = spied();
    const scoped = forSession(inner, "sess-1");
    await scoped.start("digest", {});
    await scoped.start("digest", {}, { key: "session", label: "x" });
    await scoped.start("digest", {}, { key: "phone:+1" });
    expect(start.mock.calls.map((c) => (c as unknown[])[2])).toEqual([
      { key: "sess-1" },
      { key: "sess-1", label: "x" },
      { key: "phone:+1" },
    ]);
  });

  test("every keyed read and write accepts the literal and keeps an explicit key", async () => {
    const { inner, find, latest, live, findByKey, cancelAll, signalRun } = spied();
    const scoped = forSession(inner, "sess-1");
    await scoped.find("digest", "session", { limit: 1 });
    await scoped.latest("digest");
    await scoped.live("digest", "explicit");
    await scoped.findByKey("session", { limit: 2 });
    await scoped.cancelAll("digest", "session");
    await scoped.signalRun("digest", "session", "approval", { ok: true }, { holdMs: 1 });
    expect(find).toHaveBeenCalledWith("digest", "sess-1", { limit: 1 });
    expect(latest).toHaveBeenCalledWith("digest", "sess-1");
    expect(live).toHaveBeenCalledWith("digest", "explicit");
    expect(findByKey).toHaveBeenCalledWith("sess-1", { limit: 2 });
    expect(cancelAll).toHaveBeenCalledWith("digest", "sess-1");
    expect(signalRun).toHaveBeenCalledWith(
      "digest",
      "sess-1",
      "approval",
      { ok: true },
      { holdMs: 1 },
    );
  });

  test("everything else is the client's own", () => {
    const { inner } = spied();
    const scoped = forSession(inner, "sess-1");
    expect(scoped.get).toBe(inner.get);
    expect(scoped.listing).toBe(inner.listing);
    expect(scoped.signal).toBe(inner.signal);
  });
});

describe("withNotify", () => {
  test("scopes the client to the session even with no notifier", async () => {
    const { inner, start } = spied();
    const scoped = withNotify(inner, undefined, "sess-1");
    await scoped?.start("digest", {});
    expect(start).toHaveBeenCalledWith("digest", {}, { key: "sess-1" });
  });

  test("leaves a client with no session id untouched", () => {
    const { inner } = spied();
    expect(withNotify(inner, undefined, undefined)).toBe(inner);
    expect(withNotify(undefined, undefined, "sess-1")).toBeUndefined();
  });
});
