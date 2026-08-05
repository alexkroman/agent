// Copyright 2026 the AAI authors. MIT license.
/**
 * Shared scaffolding for the two studio-route suites
 * (studio-routes.test.ts and studio-routes-contract.test.ts).
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
import type { StudioDeployResult } from "./studio-deploy.ts";
import type { StudioSessionBroker } from "./studio-session-broker.ts";

export const deployMock = vi.fn(
  async (..._args: unknown[]): Promise<StudioDeployResult> => ({
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

export const brokerMock = vi.fn((): StudioSessionBroker => fakeBroker());

/** The options the routes handed the broker factory on its first build. */
export function brokerOptions(): Record<string, unknown> {
  return (brokerMock.mock.calls as unknown as unknown[][])[0]?.[0] as Record<string, unknown>;
}

// Preview wake-up: observable fake so the session route's wiring is
// asserted without real HTTP (behavior lives in studio-preview.test.ts).
export const wakePreviewMock = vi.fn();

/** A dev-auth browser session token, the way the login screen mints one. */
export const devToken = (email: string) =>
  `dev.${Buffer.from(JSON.stringify({ id: `dev:${email}`, email }))
    .toString("base64url")
    .replace(/=+$/, "")}.dev`;

export function createProject(fetch: TestFetch, name = "proj", key = "key1"): Promise<Response> {
  return authFetch(fetch, "/studio/projects", { body: { name }, key });
}
