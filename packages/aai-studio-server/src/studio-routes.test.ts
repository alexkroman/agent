// Copyright 2025 the AAI authors. MIT license.
// Studio HTTP surface, exercised through the full orchestrator (routing
// order vs the /:slug routes matters and is covered here). The response
// CONTRACT — error bodies, `ok` acknowledgements, broker/deploy wiring —
// lives in studio-routes-contract.test.ts; shared fakes in
// _studio-routes-test-utils.ts.

import { authFetch, captureLogs, type TestFetch } from "aai-server/test-utils";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { devToken, onboardKey, withDevAuth } from "./_studio-auth-test-utils.ts";
import { clientDistFile, clientShellHtml } from "./_studio-client-dist-test-utils.ts";
import {
  createProject,
  deployMock,
  ensureSessionMock,
  lastWake,
  listedProjects,
  wakePreviewMock,
} from "./_studio-routes-test-utils.ts";
import { createTestCombined } from "./_test-combined.ts";
import { requestPublicOrigin } from "./studio-context.ts";
import { STUDIO_LLM_MODELS } from "./studio-llm.ts";
import { studioScope } from "./studio-workspace.ts";

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

describe("studio page + routing", () => {
  test("GET / serves the studio shell with a strict CSP", async () => {
    const { fetch } = await createTestCombined();
    const res = await fetch("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    // The body is pinned to the CURRENT client build rather than to
    // `<!DOCTYPE html>`, which the built shell and the not-built fallback both
    // satisfy — so it used to hold whichever of the two it got. Derived from
    // the same bytes the handler reads, so it is deterministic in a checkout
    // that has built the client and in one that has not.
    expect(await res.text()).toEqual(
      clientShellHtml() ?? expect.stringContaining("has not been built"),
    );
  });

  test("GET /favicon.ico serves the studio icon when built, else the handler's own 404", async () => {
    const { fetch } = await createTestCombined();
    const icon = clientDistFile("favicon.ico");
    const res = await fetch("/favicon.ico");
    // Not "200 or 404" — that accepts everything. The expected outcome is
    // derived from the build output, and the 404 arm names the FAVICON
    // handler's message, so falling through to the agent slug routes (or to
    // no route at all) fails in either environment.
    const served = icon
      ? { status: res.status, detail: res.headers.get("Content-Type") }
      : { status: res.status, detail: await res.text() };
    expect(served).toEqual(
      icon
        ? { status: 200, detail: "image/x-icon" }
        : { status: 404, detail: expect.stringContaining("Favicon not found") },
    );
  });

  test("GET /studio/chat/<project> serves the shell (v0-style project URLs)", async () => {
    const { fetch } = await createTestCombined();
    const res = await fetch("/studio/chat/contact-form-x7k2mq");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    // The SAME shell, byte for byte — the client reads the project from the
    // path, so a project URL that served anything else would be a different
    // app, not a deep link into this one.
    expect(await res.text()).toBe(await (await fetch("/")).text());
  });

  test("GET /studio/api/<slug> serves the shell, with NO bearer", async () => {
    // The public API page. It is the same shell — the client reads the slug
    // from the path and documents that agent from the agent's own public
    // routes — and the request carries no Authorization header at all, which
    // is the whole feature: a link to it has to work for a reader with no
    // studio account. Exercised through the full orchestrator because the
    // routing ORDER is the risk: `/studio/*` hangs auth middleware on its own
    // subtrees, and `/:slug` sits beside it.
    const { fetch } = await createTestCombined();
    const res = await fetch("/studio/api/contact-form-x7k2mq");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toBe(await (await fetch("/")).text());
  });

  test("but a path that could never name an agent is not a page", async () => {
    // The negative beside the positive: the route carries the platform's own
    // slug pattern, so `/studio/api/<junk>` falls through rather than serving
    // a shell that would document nothing. Without this the assertion above
    // passes for a route matching anything at all.
    const { fetch } = await createTestCombined();
    expect((await fetch("/studio/api/Not A Slug")).status).toBe(404);
  });

  test("GET /studio and /studio/ redirect to the page", async () => {
    const { fetch } = await createTestCombined();
    expect((await fetch("/studio")).status).toBe(302);
    expect((await fetch("/studio/")).status).toBe(302);
  });

  test("studio assets 404 when unknown and 400 on traversal", async () => {
    const { fetch } = await createTestCombined();
    expect((await fetch("/studio-assets/assets/nope.js")).status).toBe(404);
    expect((await fetch("/studio-assets/..%2f..%2fpackage.json")).status).toBe(400);
  });

  test("GET /studio/status is public and reports the caller-keyed LLM", async () => {
    const { fetch } = await createTestCombined();
    const res = await fetch("/studio/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      provider: "assemblyai",
      model: "gpt-5.5",
    });
  });

  // Was "status reports the gateway provider/model when configured" and
  // configured nothing: it stubbed STUDIO_LLM_PROVIDER — a knob NO production
  // source reads — plus an EMPTY STUDIO_LLM_MODEL, then asserted the same
  // default body as the test above it. `vi.stubEnv` accepts any name, so the
  // dead one was silent; the same shape as the `lru-eviction` suite the
  // server guide records, which configured two settings that no longer
  // existed and stayed green while testing nothing.
  test("an explicit STUDIO_LLM_MODEL is what status reports", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "test-key");
    vi.stubEnv("STUDIO_LLM_MODEL", "claude-sonnet-4-6");
    const { fetch } = await createTestCombined();
    expect(await (await fetch("/studio/status")).json()).toEqual({
      provider: "assemblyai",
      model: "claude-sonnet-4-6",
    });
  });

  test("an EMPTY STUDIO_LLM_MODEL means unset, not a model named ''", async () => {
    // studio-llm.ts resolves this with `||` rather than `??` precisely so an
    // empty env var falls back; nothing pinned that, and `??` would ship a
    // status body (and a gateway request) naming the empty string.
    vi.stubEnv("ASSEMBLYAI_API_KEY", "test-key");
    vi.stubEnv("STUDIO_LLM_MODEL", "");
    const { fetch } = await createTestCombined();
    const body = (await (await fetch("/studio/status")).json()) as { model: string };
    expect(body.model).not.toBe("");
    expect(body.model).toBe(STUDIO_LLM_MODELS[0]);
  });

  test("studio slugs are reserved: agent routes 404 and deploys reject them", async () => {
    const { fetch } = await createTestCombined();
    expect((await fetch("/studio/websocket")).status).toBe(404);
    for (const slug of ["studio", "studio-assets"]) {
      const res = await authFetch(fetch, "/deploy", {
        body: {
          slug,
          worker: "export default {}",
          clientFiles: {},
          agentConfig: { name: "x", systemPrompt: "s", toolSchemas: [] },
        },
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("studio auth", () => {
  test("project routes require a bearer key", async () => {
    const { fetch } = await createTestCombined();
    expect((await fetch("/studio/projects")).status).toBe(401);
    expect((await fetch("/studio/projects/x", { method: "DELETE" })).status).toBe(401);
  });

  test("workspaces are namespaced per key", async () => {
    const { fetch } = await createTestCombined();
    await createProject(fetch, "mine", "key1");
    expect(await listedProjects(fetch)).toEqual(["mine"]);
    expect(await listedProjects(fetch, "key2")).toEqual([]);
  });
});

describe("chat history routes", () => {
  const HISTORY = [
    { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
    { id: "m2", role: "assistant", parts: [{ type: "text", text: "hello" }] },
  ];

  test("GET chat is bearer-auth'd and 404s for a missing project", async () => {
    const { fetch } = await createTestCombined();
    expect((await fetch("/studio/projects/proj/chat")).status).toBe(401);
    expect((await authFetch(fetch, "/studio/projects/ghost/chat", { method: "GET" })).status).toBe(
      404,
    );
  });

  test("a project with no chat yet returns an empty message list", async () => {
    const { fetch } = await createTestCombined();
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/projects/proj/chat", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
  });

  test("a persisted conversation round-trips through the route", async () => {
    const { fetch, chats } = await createTestCombined();
    await createProject(fetch);
    await chats.putChat(studioScope("key1"), "proj", HISTORY);
    const res = await authFetch(fetch, "/studio/projects/proj/chat", { method: "GET" });
    expect(await res.json()).toEqual({ messages: HISTORY });
  });

  test("chats are namespaced per key — another key's project 404s", async () => {
    const { fetch, chats } = await createTestCombined();
    await createProject(fetch);
    await chats.putChat(studioScope("key1"), "proj", HISTORY);
    expect(
      (await authFetch(fetch, "/studio/projects/proj/chat", { method: "GET", key: "key2" })).status,
    ).toBe(404);
  });

  test("deleting the project deletes its chat row too", async () => {
    const { fetch, chats } = await createTestCombined();
    await createProject(fetch);
    const scope = studioScope("key1");
    await chats.putChat(scope, "proj", HISTORY);
    await authFetch(fetch, "/studio/projects/proj", { method: "DELETE" });
    expect(await chats.getChat(scope, "proj")).toBeNull();
  });
});

describe("deploy + chat endpoints", () => {
  const logs = captureLogs();
  let fetch: TestFetch;
  beforeEach(async () => {
    deployMock.mockClear();
    ensureSessionMock.mockClear();
    ({ fetch } = await createTestCombined());
  });

  test("deploy route runs the pipeline and returns the URL + CLI output", async () => {
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/projects/proj/deploy", { body: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      slug: "proj",
      url: "/proj/",
      output: "Deployed /proj/",
    });
    // Read off the TYPED fake (see _studio-routes-test-utils.ts): a cast here
    // would stop reporting the day `StudioDeployParams` gains or renames a
    // field, which is the whole thing this assertion watches.
    const params = deployMock.mock.calls[0]?.[1];
    expect(params).toMatchObject({
      apiKey: "key1",
      project: "proj",
      // Combined/dev: the request URL's own origin is the public origin the
      // guest's `aai deploy` dials.
      serverUrl: expect.stringMatching(/^https?:\/\//),
    });
  });

  test("deploy route surfaces pipeline errors as 400", async () => {
    await createProject(fetch);
    deployMock.mockResolvedValueOnce({ ok: false, error: "Build failed: nope" });
    const res = await authFetch(fetch, "/studio/projects/proj/deploy", { body: {} });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("Build failed");
  });

  /**
   * A refused Publish has to leave a trace SERVER-side, which for a long time
   * it did not: `error-handler.ts` logs 5xx only, and a route that RETURNS
   * `c.json(…, 400)` never reaches that handler, so production showed
   * `POST /studio/projects/<p>/deploy -> 400` with the reason nowhere. The
   * assertion is on the LINE, not its wording (see `captureLogs`), plus the
   * reason riding in the context — the reason is the whole point of the line.
   */
  test("a refused deploy is logged with its reason", async () => {
    await createProject(fetch);
    deployMock.mockResolvedValueOnce({ ok: false, error: "Build failed: nope" });
    await authFetch(fetch, "/studio/projects/proj/deploy", { body: {} });
    expect(logs.warns()).toContainEqual(expect.stringContaining("deploy refused"));
    const line = logs.all().find((l) => l.msg.includes("deploy refused"));
    expect(line?.ctx).toMatchObject({ project: "proj", reason: "Build failed: nope" });
  });

  test("session 404s for a missing project", async () => {
    const res = await authFetch(fetch, "/studio/projects/ghost/session", { body: {} });
    expect(res.status).toBe(404);
  });

  test("session boots the project sandbox and returns its public chat URL", async () => {
    await createProject(fetch);
    const res = await authFetch(fetch, "/studio/projects/proj/session", { body: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: "https://tunnel.example/studio/chat",
      token: "chat-token-1",
    });
    // The broker got the caller's own key — it becomes the guest's LLM
    // credential and the chat surface's bearer.
    const call = ensureSessionMock.mock.calls.at(-1);
    expect(call?.[0]).toBe(studioScope("key1"));
    expect(call?.[1]).toBe("proj");
    expect(call?.[2]).toBe("key1");
  });

  /**
   * Both preview triggers this route arms — the sandbox's own end-of-turn sync
   * (via the broker's `preview` origin) and the project-open wake — must carry
   * the SAME origin, built once. A queued preview job that omits the caller's
   * `userId` cannot be run by any replica but this one: the drain resolves a
   * user's key from Vault, and a job with nobody to resolve is archived, so the
   * preview silently never lands. Two of the three schedule paths had drifted
   * into building their own origin and losing the field.
   */
  test("session arms both preview triggers with one origin, naming the caller", async () => {
    const { fetch: authed } = await withDevAuth();
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
    // The wake's target is that same origin plus the credential — read off a
    // TYPED fake (see _studio-routes-test-utils.ts) rather than re-narrowed
    // here, so a renamed field on `PreviewTarget` fails to compile.
    expect(lastWake().target).toEqual({ ...brokered, apiKey: "users-own-key" });
  });

  test("session requires a bearer key", async () => {
    const res = await fetch("/studio/projects/proj/session", { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("session is rate limited per scope with a Retry-After", async () => {
    await createProject(fetch);
    for (let i = 0; i < 30; i += 1) {
      expect((await authFetch(fetch, "/studio/projects/proj/session", { body: {} })).status).toBe(
        200,
      );
    }
    const limited = await authFetch(fetch, "/studio/projects/proj/session", { body: {} });
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: string }).error).toContain("Rate limit");
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
    // Another scope is unaffected: it reaches the broker (404 for a project
    // the fake broker treats as missing) instead of being answered 429.
    expect(
      (await authFetch(fetch, "/studio/projects/ghost/session", { body: {}, key: "key2" })).status,
    ).toBe(404);
  });

  test("project creation is rate limited per scope", async () => {
    for (let i = 0; i < 60; i += 1) {
      expect((await createProject(fetch, `proj-${i}`)).status).toBe(201);
    }
    const limited = await createProject(fetch, "one-too-many");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
  });
});

describe("requestPublicOrigin", () => {
  /** A request as the studio sees it behind Modal: cleartext, public Host. */
  const behindTls = (headers: Record<string, string> = {}) =>
    ({
      req: {
        raw: new Request("http://agent.example.modal.run/studio/projects/p/deploy", { headers }),
      },
    }) as unknown as Parameters<typeof requestPublicOrigin>[0];

  test("publishes https for a public host behind a TLS-terminating proxy", () => {
    // Publish hands this origin to the guest's `aai deploy`. Resolving it as
    // http:// made the platform 308-redirect the deploy POST to https, which
    // strips Authorization across the scheme change — every Publish 401'd.
    expect(requestPublicOrigin(behindTls(), {})).toBe("https://agent.example.modal.run");
  });

  test("honors the agent service's forwarded headers in split mode", () => {
    const origin = requestPublicOrigin(
      behindTls({ "x-forwarded-host": "public.example", "x-forwarded-proto": "https" }),
      {},
    );
    expect(origin).toBe("https://public.example");
  });

  test("AAI_PUBLIC_ORIGIN still wins", () => {
    expect(requestPublicOrigin(behindTls(), { AAI_PUBLIC_ORIGIN: "https://aai.example/" })).toBe(
      "https://aai.example",
    );
  });
});
