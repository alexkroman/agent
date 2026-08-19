// Copyright 2026 the AAI authors. MIT license.
/**
 * Shared scaffolding for the studio-route suites. The dev-auth half (session
 * tokens, the onboarding PUT) lives next door in _studio-auth-test-utils.ts,
 * which the suites that never mock a route need without these fakes.
 *
 * The mock *state* lives here so both files observe the same fakes; the
 * `vi.mock` calls themselves cannot — they are hoisted per module, so each
 * suite declares its own and reaches these instances through an `await
 * import()` inside the (async) factory. That indirection is what keeps the
 * factory from touching a top-level binding before it is initialized.
 */

import type { TestFetch } from "aai-server/test-utils";
import { authFetch } from "aai-server/test-utils";
import { vi } from "vitest";
import type { deployStudioProject, StudioDeployResult } from "./studio-deploy.ts";
import type { wakeProjectPreview } from "./studio-preview-wake.ts";
import type { createStudioSessionBroker, StudioSessionBroker } from "./studio-session-broker.ts";

/**
 * Every fake below is declared with `Parameters<typeof …>` of the function it
 * stands in for — the seam `ensureSessionMock` already had and the others did
 * not. Untyped `vi.fn()`s pushed the narrowing out to the call sites, where
 * four of them re-derived it by hand with a cast; a cast at the READ end also
 * stops reporting when the real signature gains or renames a field, which is
 * the whole thing these wiring assertions exist to notice.
 */
export const deployMock = vi.fn(
  async (..._args: Parameters<typeof deployStudioProject>): Promise<StudioDeployResult> => ({
    ok: true,
    slug: "proj",
    url: "/proj/",
    output: "Deployed /proj/",
  }),
);

// Session broker: replace sandbox provisioning with an observable fake so
// the route's gating/wiring is exercised without Modal.
export const ensureSessionMock = vi.fn(
  async (...args: Parameters<StudioSessionBroker["ensureSession"]>) =>
    args[1] === "ghost"
      ? null
      : { url: "https://tunnel.example/studio/chat", token: "chat-token-1" },
);
export const deployWorkspaceMock = vi.fn(
  async (
    _scope: string,
    _project: string,
    _files: Record<string, string>,
    _target: { serverUrl: string; apiKey: string; slug?: string | undefined },
  ) => ({
    ok: true,
    slug: "p",
    url: "https://platform.example/p",
    output: "Deployed https://platform.example/p",
  }),
);
export const schedulePreviewMock = vi.fn();
export const refreshSessionMock = vi.fn(
  async (..._args: Parameters<StudioSessionBroker["refreshSession"]>) => true,
);

/** A broker whose every method is one of the observable fakes above. */
export function fakeBroker(over: Partial<StudioSessionBroker> = {}): StudioSessionBroker {
  return {
    ensureSession: (...args: Parameters<StudioSessionBroker["ensureSession"]>) =>
      ensureSessionMock(...args),
    refreshSession: (...args: Parameters<StudioSessionBroker["refreshSession"]>) =>
      refreshSessionMock(...args),
    schedulePreview: (...args: Parameters<StudioSessionBroker["schedulePreview"]>) =>
      schedulePreviewMock(...args),
    deployWorkspace: (...args: Parameters<StudioSessionBroker["deployWorkspace"]>) =>
      deployWorkspaceMock(...args),
    dispose: async () => undefined,
    ...over,
  };
}

export const brokerMock = vi.fn(
  (..._args: Parameters<typeof createStudioSessionBroker>): StudioSessionBroker => fakeBroker(),
);

/**
 * The options the routes handed the broker factory on its first build. Throws
 * rather than returning `undefined`: every caller is asserting ON those
 * options, so "the factory was never called" is a failure with a name, not a
 * value for four call sites to re-narrow.
 */
export function brokerOptions(): Parameters<typeof createStudioSessionBroker>[0] {
  const opts = brokerMock.mock.calls[0]?.[0];
  if (!opts) throw new Error("the studio session broker factory was never called");
  return opts;
}

// Preview wake-up: observable fake so the session route's wiring is
// asserted without real HTTP (behavior lives in studio-preview.test.ts).
export const wakePreviewMock = vi.fn(
  (..._args: Parameters<typeof wakeProjectPreview>): void => undefined,
);

/** The options of the most recent wake — typed, so no call site re-narrows. */
export function lastWake(): Parameters<typeof wakeProjectPreview>[0] {
  const options = wakePreviewMock.mock.calls.at(-1)?.[0];
  if (!options) throw new Error("wakeProjectPreview was never called");
  return options;
}

export function createProject(fetch: TestFetch, name = "proj", key = "key1"): Promise<Response> {
  return authFetch(fetch, "/studio/projects", { body: { name }, key });
}

/**
 * The project names `key` can see — the answer every scoping assertion is
 * about, and the read four suites open-coded as a doubly-nested `await` plus a
 * cast to re-narrow the body they had just parsed.
 */
export async function listedProjects(fetch: TestFetch, key = "key1"): Promise<string[]> {
  const res = await authFetch(fetch, "/studio/projects", { method: "GET", key });
  return ((await res.json()) as { projects: string[] }).projects;
}
