// Copyright 2026 the AAI authors. MIT license.
/**
 * The two routes that wake a project's preview, at the wiring level — what
 * reaches `wakeProjectPreview` and with what. The wake's own behaviour (the
 * broker 404 check, the stale-redeploy gates, the sandbox warm-up) is
 * studio-preview.test.ts.
 *
 * They are one file because they are one mechanism with two triggers, and the
 * pair is the whole point: the session call fires ONCE per project open, so on
 * its own it cannot correct a preview swept out from under a tab that stays
 * open. That gap ran in production — the Preview pane polled `/:slug/health`
 * 1,061 times across 50 minutes against a slug nothing was going to redeploy,
 * and recovered only when the user happened to do something that brokered a
 * session.
 *
 * Split from studio-routes.test.ts to keep both files under the test-file
 * length cap; the shared fakes live in _studio-routes-test-utils.ts.
 */

import { createRateLimiter } from "aai-server/http";
import { authFetch } from "aai-server/test-utils";
import { describe, expect, test, vi } from "vitest";
import { devToken, onboardKey, withDevAuth } from "./_studio-auth-test-utils.ts";
import { createProject, lastWake, wakePreviewMock } from "./_studio-routes-test-utils.ts";
import { createTestCombined } from "./_test-combined.ts";
import { CHAT_RATE_LIMIT, PROJECT_CREATE_RATE_LIMIT } from "./studio-rate-limit.ts";
import { studioScope } from "./studio-workspace.ts";

// The orchestrator constructs its studio routes internally; intercept the
// session broker and the preview wake at the module boundary so no sandbox
// runs here. The fakes are reached through an `await import()` because a
// vi.mock factory is hoisted above the imports.
vi.mock("./studio-session-broker.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./studio-session-broker.ts")>();
  const { brokerMock } = await import("./_studio-routes-test-utils.ts");
  return {
    ...original,
    createStudioSessionBroker: (...args: Parameters<typeof original.createStudioSessionBroker>) =>
      brokerMock(...args),
  };
});

vi.mock("./studio-preview-wake.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./studio-preview-wake.ts")>();
  const { wakePreviewMock: mock } = await import("./_studio-routes-test-utils.ts");
  return {
    ...original,
    wakeProjectPreview: (...args: Parameters<typeof original.wakeProjectPreview>) => mock(...args),
  };
});

describe("opening a project wakes its preview", () => {
  test("a successful session broker call wakes the project's preview", async () => {
    wakePreviewMock.mockClear();
    const { fetch } = await createTestCombined();
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/projects/proj/session", { body: {} });
    expect(res.status).toBe(200);
    expect(wakePreviewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: studioScope("key1"),
        project: "proj",
        target: expect.objectContaining({
          apiKey: "key1",
          serverUrl: expect.stringMatching(/^https?:/),
        }),
        schedule: expect.any(Function),
      }),
    );
    // A missing project never wakes anything.
    wakePreviewMock.mockClear();
    await authFetch(fetch, "/studio/projects/ghost/session", { body: {} });
    expect(wakePreviewMock).not.toHaveBeenCalled();
  });

  /**
   * The session call arms preview deploys twice over — the broker installs
   * the origin the guest's end-of-turn sync will schedule against, and the
   * wake carries one for the deploy it may enqueue itself. Both must be the
   * SAME origin, built once. A queued preview job that omits the caller's
   * `userId` cannot be run by any replica but this one: the drain resolves a
   * user's key from Vault, and a job with nobody to resolve is archived, so the
   * preview silently never lands. Two of the three schedule paths had drifted
   * into building their own origin and losing the field.
   */
  test("session arms both preview triggers with one origin, naming the caller", async () => {
    const { fetch: authed } = await withDevAuth();
    const { ensureSessionMock } = await import("./_studio-routes-test-utils.ts");
    const bearer = devToken("a@b.c");
    await onboardKey(authed, bearer);
    await createProject(authed, "proj", bearer);
    wakePreviewMock.mockClear();
    ensureSessionMock.mockClear();

    expect(
      (await authFetch(authed, "/studio/projects/proj/session", { body: {}, key: bearer })).status,
    ).toBe(200);

    const brokered = ensureSessionMock.mock.calls.at(-1)?.[3];
    expect(brokered).toEqual({ serverUrl: expect.any(String), userId: "dev:a@b.c" });
    // The wake's target is that same origin plus the credential — off the
    // typed fake, so no call site re-narrows it by hand.
    expect(lastWake().target).toEqual({ ...brokered, apiKey: "users-own-key" });
  });
});

/**
 * The second trigger, and the only one reachable from a tab that never
 * re-opens the project — see the file header for what that cost.
 */
describe("the Preview pane can wake the preview", () => {
  const wakeUrl = "/studio/projects/proj/preview/wake";

  test("a report from the pane reaches the same wake the session call does", async () => {
    const { fetch } = await createTestCombined();
    await createProject(fetch);
    wakePreviewMock.mockClear();
    const res = await authFetch(fetch, wakeUrl, { body: {} });
    expect(res.status).toBe(202);
    // Identical shape to the session route's wake — one call site builds it,
    // so the two triggers cannot drift on `userId` (see previewOrigin).
    expect(wakePreviewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: studioScope("key1"),
        project: "proj",
        target: expect.objectContaining({ apiKey: "key1" }),
        schedule: expect.any(Function),
      }),
    );
  });

  test("names the caller, so a redelivered job can still deploy", async () => {
    const { fetch: authed } = await withDevAuth();
    const bearer = devToken("a@b.c");
    await onboardKey(authed, bearer);
    await createProject(authed, "proj", bearer);
    wakePreviewMock.mockClear();

    expect((await authFetch(authed, wakeUrl, { body: {}, key: bearer })).status).toBe(202);
    expect(lastWake().target).toEqual({
      serverUrl: expect.any(String),
      userId: "dev:a@b.c",
      apiKey: "users-own-key",
    });
  });

  test("throttled per project — a wake costs a broker call that can spawn", async () => {
    const { fetch } = await createTestCombined();
    await createProject(fetch);
    wakePreviewMock.mockClear();
    for (let i = 0; i < 5; i += 1) {
      expect((await authFetch(fetch, wakeUrl, { body: {} })).status).toBe(202);
    }
    // Still 202 while throttled: the pane sends this once per missing preview
    // and does not act on the answer, so refusing would only teach it to
    // retry something already scheduled.
    expect(wakePreviewMock).toHaveBeenCalledTimes(1);
  });

  test("another scope is not throttled by the first — the key is the project", async () => {
    const { fetch } = await createTestCombined();
    await createProject(fetch);
    await createProject(fetch, "proj", "key2");
    wakePreviewMock.mockClear();
    await authFetch(fetch, wakeUrl, { body: {} });
    await authFetch(fetch, wakeUrl, { body: {}, key: "key2" });
    expect(wakePreviewMock).toHaveBeenCalledTimes(2);
    const scopes = wakePreviewMock.mock.calls.map((call) => call[0].scope);
    expect(new Set(scopes).size).toBe(2);
  });

  /**
   * And METERED, which the throttle above cannot be a substitute for: it is a
   * fixed-size `TtlCache`, i.e. an LRU, so a caller cycling more distinct
   * project names than it holds evicts entries faster than they expire and
   * every request lands as a first one. The route's own doc used to justify
   * being unmetered by "the throttle below".
   */
  test("rate limited per scope, with a Retry-After", async () => {
    const { fetch } = await createTestCombined({
      studioRateLimiters: {
        chat: createRateLimiter(CHAT_RATE_LIMIT),
        projectCreate: createRateLimiter(PROJECT_CREATE_RATE_LIMIT),
        previewWake: createRateLimiter({ limit: 1, windowMs: 60_000 }),
      },
    });
    await createProject(fetch);
    await createProject(fetch, "other-proj");
    expect((await authFetch(fetch, wakeUrl, { body: {} })).status).toBe(202);
    // A DIFFERENT project, so the per-project throttle is not what answers.
    const limited = await authFetch(fetch, "/studio/projects/other-proj/preview/wake", {
      body: {},
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
  });

  test("requires a bearer key", async () => {
    const { fetch } = await createTestCombined();
    expect((await fetch(wakeUrl, { method: "POST" })).status).toBe(401);
  });
});
