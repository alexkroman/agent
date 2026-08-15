// Copyright 2026 the AAI authors. MIT license.
/**
 * Publish — the host->guest `workspace/deploy` path (studio-session-publish.ts)
 * reached through the broker's public surface, which is the only way in.
 *
 * Its own suite rather than a section of studio-session-broker.test.ts: what
 * it asserts is a FAILURE contract (a dead or unspawnable sandbox has to come
 * back as deploy OUTPUT the coding agent can read, never a throw) plus the
 * `afterDeploy` hook, none of which is about session lifecycle.
 */

import { createMemoryChatStore } from "aai-server/chat-store";
import { createMemoryWorkspaceStore } from "aai-server/workspace-store";
import { describe, expect, test, vi } from "vitest";
import { fakeGuest, makeBroker, PROJECT, SCOPE } from "./_studio-session-test-utils.ts";
import { createMemoryPreviewQueue } from "./studio-preview-queue.ts";
import { createStudioSessionBroker } from "./studio-session-broker.ts";
import { createWorkspace } from "./studio-workspace.ts";

describe("studio publish (workspace/deploy)", () => {
  // Publish output is posted into the chat for the coding agent to read, so a
  // sandbox that dies mid-build (an OOM at the bundler's peak is the
  // realistic one) has to come back as deploy OUTPUT. Thrown, it reached the
  // route as a bare 500 with nothing anyone could act on.
  test("a sandbox that dies mid-publish returns failure output, not a throw", async () => {
    const guest = fakeGuest();
    // No live chat session for this project, so Publish spawns its own
    // sandbox — the path that had no error handling at all.
    guest.warm.conn.dispose();
    const { broker } = await makeBroker([guest]);

    const outcome = await broker.deployWorkspace(
      SCOPE,
      PROJECT,
      { "agent.ts": "// v1" },
      {
        serverUrl: "https://platform.example",
        apiKey: "caller-key",
      },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.output).toMatch(/stopped responding/i);
    expect(outcome.output).toMatch(/out of memory/i);
    await broker.dispose();
  });

  // The other half of the same path: killing the sandbox early enough means
  // the SPAWN fails (the dial times out) rather than the deploy RPC. Same
  // user-visible situation, and it took the same unhandled route to a 500.
  test("a sandbox that never starts returns failure output, not a throw", async () => {
    const workspaces = createMemoryWorkspaceStore();
    const chats = createMemoryChatStore();
    await createWorkspace(workspaces, SCOPE, PROJECT, { files: { "agent.ts": "// v1" } });
    const broker = createStudioSessionBroker({
      workspaces,
      chats,
      spawn: (async () => {
        throw new Error("guest WebSocket not dialable after 30000ms");
      }) as never,
      harnessPath: "/fake/harness.mjs",
      previewQueue: createMemoryPreviewQueue(),
    });

    const outcome = await broker.deployWorkspace(
      SCOPE,
      PROJECT,
      { "agent.ts": "// v1" },
      {
        serverUrl: "https://platform.example",
        apiKey: "caller-key",
      },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.output).toMatch(/could not start a build sandbox/i);
    expect(outcome.output).toMatch(/nothing was deployed/i);
    await broker.dispose();
  });

  // `afterDeploy` is what lets a per-deploy consequence — the studio uses it
  // to give a newly claimed slug the database its project asked for — be
  // wired ONCE for both deploy paths (Publish and the auto preview) instead
  // of into one and forgotten in the other.
  test("afterDeploy runs with the claimed slug, on success only", async () => {
    const afterDeploy = vi.fn(async () => undefined);
    const { broker } = await makeBroker([fakeGuest(), fakeGuest()], { afterDeploy });
    const target = { serverUrl: "https://platform.example", apiKey: "caller-key" };

    await broker.deployWorkspace(SCOPE, PROJECT, { "agent.ts": "// v1" }, target);
    expect(afterDeploy).toHaveBeenCalledWith(SCOPE, PROJECT, "proj");

    // A failed deploy claimed nothing, so there is nothing to reconcile.
    afterDeploy.mockClear();
    const dead = fakeGuest();
    dead.warm.conn.dispose();
    const failing = await makeBroker([dead], { afterDeploy });
    const outcome = await failing.broker.deployWorkspace(
      SCOPE,
      PROJECT,
      { "agent.ts": "// v1" },
      target,
    );
    expect(outcome.ok).toBe(false);
    expect(afterDeploy).not.toHaveBeenCalled();
    await broker.dispose();
    await failing.broker.dispose();
  });

  test("a failing afterDeploy never turns a shipped deploy into an error", async () => {
    // The CLI output is already on its way to the chat; reporting a transport
    // failure over a follow-up would be a lie about what happened.
    const afterDeploy = vi.fn(async () => {
      throw new Error("vault unavailable");
    });
    const { broker } = await makeBroker([fakeGuest()], { afterDeploy });
    const outcome = await broker.deployWorkspace(
      SCOPE,
      PROJECT,
      { "agent.ts": "// v1" },
      { serverUrl: "https://platform.example", apiKey: "caller-key" },
    );
    expect(outcome.ok).toBe(true);
    await broker.dispose();
  });
});
