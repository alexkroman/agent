// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * Specs for `useWorkflowApiRef`, the client preamble every workflow hook opens
 * with.
 *
 * Asserted on the getter itself rather than through a hook built on it: the
 * three properties are that its IDENTITY never changes (so it can sit in an
 * effect's dependency list), that it reads the caller's CURRENT client on
 * every call (so a swapped client is picked up without a restart), and that
 * the no-client default is built once. `use-workflow-run.test.ts` covers what
 * the first two buy a real watch.
 */

import { renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { createMockWorkflowApi } from "./_react-test-utils.ts";
import { useWorkflowApiRef } from "./_workflow-api-ref.ts";
import type { WorkflowApi } from "./workflow-client.ts";

describe("useWorkflowApiRef", () => {
  test("hands back the caller's client", () => {
    const api = createMockWorkflowApi();
    const { result } = renderHook(() => useWorkflowApiRef(api));
    expect(result.current()).toBe(api);
  });

  test("the getter is stable across renders, even as the client object changes", () => {
    // The natural call site passes a fresh client per render; the getter is
    // what an effect depends on, so its identity must not follow.
    const { result, rerender } = renderHook(({ api }) => useWorkflowApiRef(api), {
      initialProps: { api: createMockWorkflowApi() },
    });
    const first = result.current;
    rerender({ api: createMockWorkflowApi() });
    expect(result.current).toBe(first);
  });

  test("reads the CURRENT client per call, so a swap needs no restart", () => {
    const before = createMockWorkflowApi();
    const after = createMockWorkflowApi();
    const { result, rerender } = renderHook(({ api }) => useWorkflowApiRef(api), {
      initialProps: { api: before },
    });
    // Captured once, the way an effect would hold it.
    const getClient = result.current;
    rerender({ api: after });
    expect(getClient()).toBe(after);
  });

  test("with no client, builds ONE default lazily and keeps it", () => {
    const { result, rerender } = renderHook(() => useWorkflowApiRef(undefined));
    const built = result.current();
    rerender();
    expect(result.current()).toBe(built);
    // A real client aimed at the page's own agent, not a placeholder.
    expect(typeof built.get).toBe("function");
  });

  test("a client supplied later displaces the default", () => {
    const api = createMockWorkflowApi();
    const { result, rerender } = renderHook(
      ({ client }: { client: WorkflowApi | undefined }) => useWorkflowApiRef(client),
      { initialProps: { client: undefined as WorkflowApi | undefined } },
    );
    const fallback = result.current();
    rerender({ client: api });
    expect(result.current()).toBe(api);
    expect(result.current()).not.toBe(fallback);
  });
});
