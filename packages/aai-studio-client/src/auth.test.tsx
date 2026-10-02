// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// `useStudioAuth` — which phase the studio's front door is in, for the flows
// that need no third party: the config read and its failure, a server with
// sign-in unconfigured, and the `dev` token box.
//
// The `supabase` flow is left to the browser: it builds a real supabase-js
// client (an auth subscription, a refresh ticker, an OAuth redirect), and the
// read that decides its sign-in screen is auth-methods.test.ts's. This file is
// excluded from the coverage floors for the same reason (vitest.config.ts) —
// its lines are mostly that client's wiring, which no unit spec drives.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { jsonResponse, stubFetch } from "./_test-utils.ts";
import { type StudioAuthState, useStudioAuth } from "./auth.tsx";

const DEV_TOKEN_STORAGE = "aai-studio-dev-token";

afterEach(() => {
  localStorage.clear();
});

/** Narrow a phase, failing the spec by name rather than on a missing field. */
function inPhase<P extends StudioAuthState["phase"]>(
  state: StudioAuthState,
  phase: P,
): Extract<StudioAuthState, { phase: P }> {
  if (state.phase !== phase) throw new Error(`expected phase ${phase}, got ${state.phase}`);
  return state as Extract<StudioAuthState, { phase: P }>;
}

describe("useStudioAuth", () => {
  test("is loading until the server says which flow it runs", () => {
    stubFetch({ "/studio/auth": () => new Response(new ReadableStream()) });
    const { result } = renderHook(() => useStudioAuth());
    expect(result.current.phase).toBe("loading");
  });

  test("a server with sign-in unconfigured is unavailable, with nothing to retry", async () => {
    stubFetch({ "/studio/auth": () => jsonResponse({ mode: "none" }) });
    const { result } = renderHook(() => useStudioAuth());
    await waitFor(() => expect(result.current.phase).toBe("unavailable"));
    const state = inPhase(result.current, "unavailable");
    expect(state.message).toMatch(/Sign-in is not configured/);
    // A second read cannot change a server's configuration.
    expect(state.retry).toBeUndefined();
  });

  test("a failed config read offers a retry, and the retry reads again", async () => {
    let calls = 0;
    stubFetch({
      "/studio/auth": () =>
        ++calls === 1
          ? jsonResponse({ error: "storage exploded" }, 400)
          : jsonResponse({ mode: "dev" }),
    });
    const { result } = renderHook(() => useStudioAuth());
    await waitFor(() => expect(result.current.phase).toBe("unavailable"));
    const failed = inPhase(result.current, "unavailable");
    // Not a transient failure, so the server's own words are quoted.
    expect(failed.message).toContain("storage exploded");

    act(() => failed.retry?.());
    await waitFor(() => expect(result.current.phase).toBe("signedOut"));
    expect(calls).toBe(2);
  });

  describe("dev mode", () => {
    function renderDev() {
      stubFetch({ "/studio/auth": () => jsonResponse({ mode: "dev" }) });
      return renderHook(() => useStudioAuth());
    }

    test("offers its own one-field sign-in, with no GoTrue method", async () => {
      const { result } = renderDev();
      await waitFor(() => expect(result.current.phase).toBe("signedOut"));
      const state = inPhase(result.current, "signedOut");
      expect(state.mode).toBe("dev");
      expect(state.methods).toEqual({ github: false, password: false });
    });

    test("signing in mints the server's self-describing token and keeps it across loads", async () => {
      const { result } = renderDev();
      await waitFor(() => expect(result.current.phase).toBe("signedOut"));

      await act(() =>
        inPhase(result.current, "signedOut").signIn({ kind: "dev", email: "me@local.test" }),
      );
      const { token } = inPhase(result.current, "signedIn");
      // `dev.<base64url JSON>.dev`, the shape aai-server's `parseDevToken` reads.
      const [head, body, tail] = token.split(".");
      expect([head, tail]).toEqual(["dev", "dev"]);
      const payload = JSON.parse(atob(String(body).replaceAll("-", "+").replaceAll("_", "/")));
      expect(payload).toEqual({ id: "dev:me@local.test", email: "me@local.test" });
      expect(localStorage.getItem(DEV_TOKEN_STORAGE)).toBe(token);
    });

    test("a stored token is restored on the next load", async () => {
      localStorage.setItem(DEV_TOKEN_STORAGE, "dev.stored.dev");
      const { result } = renderDev();
      await waitFor(() => expect(result.current.phase).toBe("signedIn"));
      expect(inPhase(result.current, "signedIn").token).toBe("dev.stored.dev");
    });

    test("signing out forgets the token", async () => {
      localStorage.setItem(DEV_TOKEN_STORAGE, "dev.stored.dev");
      const { result } = renderDev();
      await waitFor(() => expect(result.current.phase).toBe("signedIn"));

      act(() => inPhase(result.current, "signedIn").signOut());
      expect(result.current.phase).toBe("signedOut");
      expect(localStorage.getItem(DEV_TOKEN_STORAGE)).toBeNull();
    });

    test("a rejected dev token is discarded, not refreshed — it has no way back", async () => {
      localStorage.setItem(DEV_TOKEN_STORAGE, "dev.stored.dev");
      const { result } = renderDev();
      await waitFor(() => expect(result.current.phase).toBe("signedIn"));

      await act(() => inPhase(result.current, "signedIn").refresh());
      expect(result.current.phase).toBe("signedOut");
      expect(localStorage.getItem(DEV_TOKEN_STORAGE)).toBeNull();
    });
  });
});
