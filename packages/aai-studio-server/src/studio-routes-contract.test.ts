// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio HTTP surface's response CONTRACT — the bodies, not just the
 * status codes: the error strings the client renders and the CLI prints, the
 * `ok` acknowledgements the client keys optimistic state off, the
 * per-user project scoping, and the wiring the routes hand the session
 * broker and the deploy pipeline.
 *
 * Split from studio-routes.test.ts to keep both files under the test-file
 * length cap; the shared fakes live in _studio-routes-test-utils.ts.
 */

import { createMemorySecretStore, createMemoryWorkspaceStore } from "aai-server/stores";
import { authFetch, type TestFetch } from "aai-server/test-utils";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { devToken, onboardKey, withDevAuth } from "./_studio-auth-test-utils.ts";
import {
  brokerMock,
  brokerOptions,
  createProject,
  deployMock,
  deployWorkspaceMock,
  fakeBroker,
} from "./_studio-routes-test-utils.ts";
import { createTestCombined } from "./_test-combined.ts";
import { MAX_STUDIO_FILES } from "./studio-limits.ts";
import { createMemoryPreviewQueue } from "./studio-preview-queue.ts";
import { createMemoryStudioSessionRegistry } from "./studio-session-registry.ts";

// The orchestrator constructs its studio routes internally; intercept the
// deploy pipeline, the session broker, and the preview wake at the module
// boundary so no bundler or sandbox runs here. The fakes are reached through
// an `await import()` because a vi.mock factory is hoisted above the imports.
vi.mock("./studio-deploy.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./studio-deploy.ts")>();
  const { deployMock: mock } = await import("./_studio-routes-test-utils.ts");
  return {
    ...original,
    deployStudioProject: (...args: Parameters<typeof original.deployStudioProject>) =>
      mock(...args),
  };
});

vi.mock("./studio-session-broker.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./studio-session-broker.ts")>();
  const { brokerMock: mock } = await import("./_studio-routes-test-utils.ts");
  return {
    ...original,
    createStudioSessionBroker: (...args: Parameters<typeof original.createStudioSessionBroker>) =>
      mock(...args),
  };
});

vi.mock("./studio-preview-wake.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./studio-preview-wake.ts")>();
  const { wakePreviewMock } = await import("./_studio-routes-test-utils.ts");
  return {
    ...original,
    wakeProjectPreview: (...args: Parameters<typeof original.wakeProjectPreview>) =>
      wakePreviewMock(...args),
  };
});

/**
 * Every failure the studio surface returns names itself in the body. These
 * are the strings the client renders and the CLI prints, so a status code
 * alone is not the contract — a 404 that says nothing reads as a broken
 * studio, and the push conflict's text is the only place the recovery
 * command appears.
 */
describe("response bodies", () => {
  let fetch: TestFetch;
  beforeEach(async () => {
    ({ fetch } = await createTestCombined());
  });

  /** The `error` field of a JSON error response. */
  async function errorOf(res: Response): Promise<string> {
    return ((await res.json()) as { error?: string }).error ?? "";
  }

  test("an unusable project name is refused before it reaches a store key", async () => {
    // `validateProject` runs in the shared middleware; without it the param
    // would flow into store keys and deploy slugs as an arbitrary segment,
    // and the request would 404 rather than 400.
    const res = await authFetch(fetch, "/studio/projects/NOT_A_SLUG!", { method: "GET" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid project name");
  });

  test("a duplicate create says the project already exists", async () => {
    await createProject(fetch);
    const res = await createProject(fetch);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("Project already exists");
  });

  test("a reserved name pushed as a new project is refused by name", async () => {
    const res = await authFetch(fetch, "/studio/projects/studio/source", {
      method: "PUT",
      body: { files: { "agent.ts": "export default {}" } },
    });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("That name is reserved");
  });

  test.each([
    ["the project", "/studio/projects/ghost-project", "GET"],
    ["its chat history", "/studio/projects/ghost-project/chat", "GET"],
    ["its coding-agent session", "/studio/projects/ghost/session", "POST"],
  ])("a missing project reports not found for %s", async (_label, path, method) => {
    const res = await authFetch(fetch, path, { method: method as "GET" | "POST" });
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe("Project not found");
  });

  test("writing a file to a missing project reports not found", async () => {
    const res = await authFetch(fetch, "/studio/projects/ghost-project/file", {
      method: "PUT",
      body: { path: "agent.ts", content: "x" },
    });
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe("Project not found");
  });

  test("deleting a file needs the path query parameter", async () => {
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/projects/proj/file", { method: "DELETE" });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("Missing path query parameter");
  });

  test("deleting a file that is not in the workspace reports file not found", async () => {
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/projects/proj/file?path=nope.ts", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe("File not found");
  });

  test("a stale push names the recovery command", async () => {
    // The CLI prints this verbatim; without the hint a 409 leaves the user
    // with a rejected push and no next step.
    const push = (body: unknown) =>
      authFetch(fetch, "/studio/projects/pushed/source", { method: "PUT", body });
    await push({ files: { "agent.ts": "v1" } });
    const stale = await push({ files: { "agent.ts": "v2" }, baseHash: "not-the-current-hash" });

    expect(stale.status).toBe(409);
    const message = await errorOf(stale);
    expect(message).toContain("aai pull");
    expect(message).toContain("--force");
  });

  test("a rejected push explains why", async () => {
    // Past the workspace file cap the write throws, and the reason has to
    // reach the CLI rather than a bare 400. Matched against the message
    // `assertWorkspaceLimits` actually raises, not merely "non-empty" —
    // `"Bad Request"` satisfies non-empty, and a bare 400 was the bug.
    const files: Record<string, string> = {};
    for (let i = 0; i < 200; i++) files[`f${i}.ts`] = "x";
    const res = await authFetch(fetch, "/studio/projects/toobig/source", {
      method: "PUT",
      body: { files },
    });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/Too many files \(max \d+\)/);
  });

  test("mutations acknowledge with ok:true", async () => {
    // The client keys its optimistic state off this flag, so an empty body or
    // `ok: false` reads as a failed write on a write that succeeded.
    await createProject(fetch);

    const written = await authFetch(fetch, "/studio/projects/proj/file", {
      method: "PUT",
      body: { path: "agent.ts", content: "export default {}" },
    });
    expect(written.status).toBe(200);
    await expect(written.json()).resolves.toEqual({ ok: true });

    const removed = await authFetch(fetch, "/studio/projects/proj/file?path=agent.ts", {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toEqual({ ok: true });

    const deleted = await authFetch(fetch, "/studio/projects/proj", { method: "DELETE" });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ ok: true });
  });

  test("a push acknowledges with ok, the new hash, and whether it created", async () => {
    const push = (body: unknown) =>
      authFetch(fetch, "/studio/projects/pushed/source", { method: "PUT", body });

    const first = await push({ files: { "agent.ts": "v1" } });
    expect(first.status).toBe(201);
    const created = (await first.json()) as {
      ok: boolean;
      sourceHash: string;
      created: boolean;
    };
    expect(created.ok).toBe(true);
    expect(created.created).toBe(true);
    expect(created.sourceHash).toBeTruthy();

    const second = await push({ files: { "agent.ts": "v2" }, baseHash: created.sourceHash });
    expect(second.status).toBe(200);
    const updated = (await second.json()) as { ok: boolean; created: boolean };
    expect(updated.ok).toBe(true);
    expect(updated.created).toBe(false);
  });

  test("deleting a project that was never created still succeeds", async () => {
    // Delete is idempotent, and the cascade reads deploy stamps off a
    // workspace that may not exist — reaching into it unguarded would 500.
    const res = await authFetch(fetch, "/studio/projects/never-existed", { method: "DELETE" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });
});

describe("browser-session scoping", () => {
  test("two signed-in users do not see each other's projects", async () => {
    // Browser sessions scope by studio USER id, so the scope input must carry
    // it — a constant would collapse every account into one project list.
    const { fetch } = await withDevAuth();
    const alice = devToken("alice@example.com");
    const bob = devToken("bob@example.com");
    // Each account onboards its own AssemblyAI key first — a session with no
    // stored key cannot reach the project routes at all.
    await onboardKey(fetch, alice, "alice-key");
    await onboardKey(fetch, bob, "bob-key");

    expect(
      (await authFetch(fetch, "/studio/projects", { body: { name: "alice-proj" }, key: alice }))
        .status,
    ).toBe(201);

    const alicesList = await authFetch(fetch, "/studio/projects", { method: "GET", key: alice });
    await expect(alicesList.json()).resolves.toEqual({ projects: ["alice-proj"] });

    const bobsList = await authFetch(fetch, "/studio/projects", { method: "GET", key: bob });
    await expect(bobsList.json()).resolves.toEqual({ projects: [] });
  });
});

describe("session broker wiring", () => {
  test("forwards the fleet options and a Vault-backed key resolver", async () => {
    brokerMock.mockClear();
    // The REAL memory implementations rather than two-method literals cast into
    // the interfaces: the broker is faked here, so nothing calls either one and
    // this asserts pass-through by identity — and a cast at that seam stops
    // reporting the day either interface grows a method.
    const registry = createMemoryStudioSessionRegistry();
    const previewQueue = createMemoryPreviewQueue();

    const secrets = createMemorySecretStore();
    const combined = await createTestCombined({
      secrets,
      studioSessionRegistry: registry,
      previewQueue,
      replicaId: "replica-7",
    });
    await createProject(combined.fetch);
    await authFetch(combined.fetch, "/studio/projects/proj/session", { method: "POST" });

    expect(brokerMock).toHaveBeenCalledTimes(1);
    const opts = brokerOptions();
    expect(opts).toMatchObject({ registry, previewQueue, replicaId: "replica-7" });

    // The drain resolves the user's key from Vault rather than the job
    // carrying one, so the resolver must read the real secret store.
    await secrets.put("user-key:dev:someone", "resolved-key");
    // No hand-written signature: `brokerOptions()` is typed off the real
    // factory's parameters now, so this is the resolver the routes actually
    // pass and a change to its shape is a compile error.
    await expect(opts.resolveApiKey?.("dev:someone")).resolves.toBe("resolved-key");
  });

  test("omits the fleet options that were not configured", async () => {
    brokerMock.mockClear();
    const combined = await createTestCombined();
    await createProject(combined.fetch);
    await authFetch(combined.fetch, "/studio/projects/proj/session", { method: "POST" });

    const opts = brokerOptions();
    expect(Object.keys(opts)).not.toContain("registry");
    expect(Object.keys(opts)).not.toContain("replicaId");
    // `previewQueue` is deliberately NOT in that list: it is required, so the
    // harness (a composition root of its own) always chooses one. The broker
    // used to substitute a memory queue itself when the key was absent, which
    // is the second decision point this asserts is gone.
    expect(opts.previewQueue).toBeDefined();
  });
});

describe("workspace failure handling", () => {
  test("deleting one file leaves the rest of the workspace intact", async () => {
    const { fetch } = await createTestCombined();
    await authFetch(fetch, "/studio/projects/multi/source", {
      method: "PUT",
      body: { files: { "agent.ts": "a", "client.tsx": "b", "keep.ts": "c" } },
    });

    const res = await authFetch(fetch, "/studio/projects/multi/file?path=client.tsx", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const after = (await (
      await authFetch(fetch, "/studio/projects/multi", { method: "GET" })
    ).json()) as { files: Record<string, string> };
    expect(Object.keys(after.files).sort()).toEqual(["agent.ts", "keep.ts"]);
  });

  test("a file write past the workspace cap is refused with the reason", async () => {
    const { fetch } = await createTestCombined();
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_STUDIO_FILES; i++) files[`f${i}.ts`] = "x";
    expect(
      (await authFetch(fetch, "/studio/projects/full/source", { method: "PUT", body: { files } }))
        .status,
    ).toBe(201);

    // One more file breaks the count cap inside the workspace write, which
    // throws — the reason has to reach the caller instead of a bare 400.
    const res = await authFetch(fetch, "/studio/projects/full/file", {
      method: "PUT",
      body: { path: "one-too-many.ts", content: "x" },
    });
    expect(res.status).toBe(400);
    // The reason itself, not `/./` — which `"Bad Request"` matches, and a bare
    // 400 is precisely what this test exists to refuse.
    expect((await res.json()) as { error?: string }).toMatchObject({
      error: expect.stringMatching(/Too many files \(max \d+\)/),
    });
  });

  test("an unexpected store failure is not reported as a duplicate", async () => {
    // Only a conflict means "already exists"; anything else has to propagate,
    // or a broken store looks to the user like a name they already used.
    const workspaces = createMemoryWorkspaceStore();
    vi.spyOn(workspaces, "put").mockRejectedValue(new Error("store offline"));
    const { fetch } = await createTestCombined({ workspaces });

    const res = await createProject(fetch);
    expect(res.status).not.toBe(409);
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

describe("studio shutdown", () => {
  test("dispose is a no-op when no session ever built the broker", async () => {
    // The broker is lazy, so shutdown on a replica that served no session
    // must not reach into an undefined one.
    const combined = await createTestCombined();
    await expect(combined.disposeStudio()).resolves.toBeUndefined();
  });

  test("dispose releases the broker's sandboxes once one exists", async () => {
    const disposeMock = vi.fn(async () => undefined);
    brokerMock.mockImplementationOnce(() => fakeBroker({ dispose: disposeMock }));
    const combined = await createTestCombined();
    await createProject(combined.fetch);
    await authFetch(combined.fetch, "/studio/projects/proj/session", { method: "POST" });

    await combined.disposeStudio();
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });
});

describe("push creation guards", () => {
  const push = (fetch: TestFetch, project: string, body: unknown) =>
    authFetch(fetch, `/studio/projects/${project}/source`, { method: "PUT", body });

  test("push-create shares the create rate limit; repeat pushes do not", async () => {
    // A first push CREATES the project, so it has to be metered like
    // `POST /projects`. A later push to that same project is an update and
    // must stay unmetered — otherwise a busy `aai push` loop locks itself out.
    const { fetch } = await createTestCombined();
    expect((await push(fetch, "existing", { files: { "agent.ts": "v1" } })).status).toBe(201);
    for (let i = 0; i < 59; i += 1) {
      expect((await push(fetch, `pushed-${i}`, { files: { "agent.ts": "x" } })).status).toBe(201);
    }

    const limited = await push(fetch, "one-too-many", { files: { "agent.ts": "x" } });
    expect(limited.status).toBe(429);

    const repeat = await push(fetch, "existing", { files: { "agent.ts": "v2" } });
    expect(repeat.status).toBe(200);
  });
});

describe("deploy route wiring", () => {
  test("hands the pipeline the workspace store and a broker-backed deploy", async () => {
    deployMock.mockClear();
    const { fetch } = await createTestCombined();
    await createProject(fetch);
    await authFetch(fetch, "/studio/projects/proj/deploy", { body: {} });

    // Typed off `deployStudioProject`'s own parameters (see the fakes in
    // _studio-routes-test-utils.ts), so a renamed or newly required dependency
    // fails here instead of compiling into a hand-written shape.
    const deps = deployMock.mock.calls[0]?.[0];
    expect(deps?.workspaces).toBeDefined();

    // Publish runs `aai deploy` inside the project's guest sandbox, so this
    // callback must reach the session broker rather than resolve to nothing.
    deployWorkspaceMock.mockClear();
    const target = { serverUrl: "https://platform.example", apiKey: "key1" };
    await deps?.deployWorkspace?.("scope", "proj", { "agent.ts": "x" }, target);
    expect(deployWorkspaceMock).toHaveBeenCalledWith("scope", "proj", { "agent.ts": "x" }, target);
  });
});
