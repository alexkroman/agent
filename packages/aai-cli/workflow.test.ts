// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for `aai workflow`.
 *
 * The two things worth pinning are the ones a reader cannot check by eye: the
 * URL these build (the platform origin plus the PUBLISHED slug, which is not the
 * project's name) and the fact that they send NO platform credential — the
 * workflow API is the agent's own surface, and putting an API key on it would be
 * both useless and a leak.
 *
 * `fetch` is stubbed rather than a server started; `getServerInfo` is mocked so
 * no project config or API key prompt is needed.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

import { getServerInfo } from "./_agent.ts";

vi.mock("./_agent.ts", () => ({
  getServerInfo: vi.fn().mockResolvedValue({
    // No trailing slash, because the real `getServerInfo` cannot return one:
    // `resolveServerUrl` strips them once, at resolution time, precisely so
    // join sites do not each carry a copy (`_agent.test.ts` pins that). The
    // fixture used to carry one, which is what kept a fourth — and subtly
    // different, `/\/$/` against `/\/+$/` — stripping regex alive in
    // `workflow.ts`.
    serverUrl: "https://agents.example",
    slug: "digest-x7k2mq",
    apiKey: "test-api-key",
  }),
}));

/**
 * The project pin, read for its SLUG before any credential is resolved.
 *
 * `target` reads this rather than letting `getServerInfo` reach
 * `requireDeployedSlug`, because that helper resolves the API key first: an
 * undeployed project's first error was `not_logged_in`, naming `aai login` for
 * a command that sends no key. Mocked here as a DEPLOYED project so the
 * platform-path cases below reach the client; `readProjectConfig` returning
 * null is its own case further down.
 */
const mockReadProjectConfig = vi.hoisted(() => vi.fn());
vi.mock("./_config.ts", () => ({ readProjectConfig: mockReadProjectConfig }));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  step: vi.fn(),
  message: vi.fn(),
}));
vi.mock("./_ui.ts", () => ({ log: mockLog }));

const { executeWorkflowCancel, executeWorkflowList, executeWorkflowRuns, executeWorkflowShow } =
  await import("./workflow.ts");

let fetchMock: ReturnType<typeof vi.fn>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  // `mockLog` is module-level, and `restoreMocks: true` registers only
  // `vi.spyOn` mocks — it clears neither the history nor the implementation of
  // a plain `vi.fn()`. Without this, an `expect(mockLog.info)
  // .toHaveBeenCalledWith(…)` below is satisfied by an EARLIER test in this
  // file: three of the list/runs cases print the same "declares no workflows"
  // and "No runs of digest yet" lines.
  vi.clearAllMocks();
  // After the clear, so the default survives it.
  mockReadProjectConfig.mockResolvedValue({ slug: "digest-x7k2mq" });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

/** The URL and init of the nth request. */
function call(n = 0): [string, RequestInit] {
  return fetchMock.mock.calls[n] as [string, RequestInit];
}

describe("executeWorkflowList", () => {
  test("reads the agent's own endpoint under the PUBLISHED slug", async () => {
    fetchMock.mockImplementation(async () => json({ workflows: [{ name: "digest" }] }));
    const result = await executeWorkflowList("/proj", {});
    expect(call()[0]).toBe("https://agents.example/digest-x7k2mq/workflows");
    expect(result).toEqual({ ok: true, data: { workflows: [{ name: "digest" }] } });
  });

  test("sends NO authorization by default", async () => {
    // The caller's API key is not what authorizes here; sending it would put a
    // platform credential on a route that does not want one.
    fetchMock.mockImplementation(async () => json({ workflows: [] }));
    await executeWorkflowList("/proj", {});
    expect(call()[1].headers).toEqual({});
  });

  test("--token rides as the agent's own bearer", async () => {
    fetchMock.mockImplementation(async () => json({ workflows: [] }));
    await executeWorkflowList("/proj", { token: "s3cret" });
    expect(call()[1].headers).toMatchObject({ Authorization: "Bearer s3cret" });
  });

  test("names the agent when it declares none, rather than printing nothing", async () => {
    fetchMock.mockImplementation(async () => json({ workflows: [] }));
    await executeWorkflowList("/proj", {});
    expect(mockLog.info).toHaveBeenCalledWith("digest-x7k2mq declares no workflows");
  });

  test("a failure keeps the AGENT'S sentence and carries the broker hint", async () => {
    // A 503 while a sandbox boots reads very differently from a 404 for an
    // agent that declares no workflows, and both look alike as a status code.
    fetchMock.mockImplementation(async () => json({ error: "agent unavailable" }, 503));
    const result = await executeWorkflowList("/proj", {});
    expect(result).toMatchObject({
      ok: false,
      code: "workflow_list_failed",
      error: "agent unavailable",
      hint: expect.stringContaining("--token"),
    });
  });

  test("a non-JSON failure degrades to the status plus the body, NAMED", async () => {
    // The label is the SDK client's and appears only on this fallback path — what
    // answered `<html>` was something in front of the agent, and a bare `502` does
    // not say which surface was being asked.
    fetchMock.mockImplementation(async () => new Response("<html>", { status: 502 }));
    const result = await executeWorkflowList("/proj", {});
    expect(result).toMatchObject({ ok: false, error: "Workflow API 502: <html>" });
  });
});

describe("executeWorkflowRuns", () => {
  test("asks for the KEYLESS read — a terminal has no correlation key", async () => {
    fetchMock.mockImplementation(async () => json({ runs: [] }));
    await executeWorkflowRuns("/proj", "digest", {});
    const url = new URL(call()[0]);
    expect(url.pathname).toBe("/digest-x7k2mq/workflows/runs");
    expect(url.searchParams.get("workflow")).toBe("digest");
    expect(url.searchParams.get("key")).toBeNull();
    expect(url.searchParams.get("limit")).toBe("20");
  });

  test("honours an explicit limit", async () => {
    fetchMock.mockImplementation(async () => json({ runs: [] }));
    await executeWorkflowRuns("/proj", "digest", { limit: 3 });
    expect(new URL(call()[0]).searchParams.get("limit")).toBe("3");
  });

  test("prints a failed run's MESSAGE, not just its status", async () => {
    // "failed" alone sends someone to the logs for something already in hand.
    fetchMock.mockImplementation(async () =>
      json({
        runs: [
          {
            runId: "wrun_1",
            workflow: "digest",
            createdAt: 0,
            status: "failed",
            error: "topic not found",
            key: "caller-1",
          },
        ],
      }),
    );
    await executeWorkflowRuns("/proj", "digest", {});
    expect(mockLog.info).toHaveBeenCalledWith("wrun_1  failed  key=caller-1  topic not found");
  });

  test("says so when a workflow has no runs yet", async () => {
    fetchMock.mockImplementation(async () => json({ runs: [] }));
    await executeWorkflowRuns("/proj", "digest", {});
    expect(mockLog.info).toHaveBeenCalledWith("No runs of digest yet");
  });
});

describe("executeWorkflowShow", () => {
  test("prints the run and its OUTPUT, which is why it exists beside `runs`", async () => {
    fetchMock.mockImplementation(async () =>
      json({
        runId: "wrun_1",
        workflow: "digest",
        createdAt: 0,
        status: "completed",
        output: { topic: "ai" },
      }),
    );
    const result = await executeWorkflowShow("/proj", "wrun_1", {});
    expect(call()[0]).toBe("https://agents.example/digest-x7k2mq/workflows/runs/wrun_1");
    expect(mockLog.info).toHaveBeenCalledWith("wrun_1  completed");
    expect(mockLog.info).toHaveBeenCalledWith(JSON.stringify({ topic: "ai" }, null, 2));
    expect(result.ok).toBe(true);
  });

  test("an unknown id is a FAILURE here, though the client reads it as an answer", async () => {
    // `api.get` resolves undefined for a 404, which is right for a page racing a
    // run it just started and wrong for a terminal: there is nothing to print.
    // The status also covers "this agent serves no workflow API", so the sentence
    // claims neither and the hint names every cause.
    fetchMock.mockImplementation(async () => json({ error: "No workflow run with id gone" }, 404));
    const result = await executeWorkflowShow("/proj", "gone", {});
    expect(result).toMatchObject({
      ok: false,
      code: "workflow_show_failed",
      error: "No run gone",
      hint: expect.stringContaining("declare no workflows"),
    });
  });

  test("percent-encodes the run id into the path", async () => {
    fetchMock.mockImplementation(async () =>
      json({ runId: "a/b", workflow: "digest", createdAt: 0, status: "running" }),
    );
    await executeWorkflowShow("/proj", "a/b", {});
    expect(call()[0]).toBe("https://agents.example/digest-x7k2mq/workflows/runs/a%2Fb");
  });
});

describe("executeWorkflowCancel", () => {
  test("sends a DELETE and reports the stop", async () => {
    fetchMock.mockImplementation(async () => json({ runId: "wrun_1", cancelled: true }));
    const result = await executeWorkflowCancel("/proj", "wrun_1", {});
    expect(call()[1].method).toBe("DELETE");
    expect(mockLog.info).toHaveBeenCalledWith("Cancelled wrun_1");
    expect(result).toEqual({ ok: true, data: { runId: "wrun_1", cancelled: true } });
  });

  test("an already-finished run SUCCEEDS and says so", async () => {
    // The route answers 200 either way, because "it was already over" is an
    // answer — two operators pressing Stop is ordinary.
    fetchMock.mockImplementation(async () => json({ runId: "wrun_1", cancelled: false }));
    const result = await executeWorkflowCancel("/proj", "wrun_1", {});
    expect(result.ok).toBe(true);
    expect(mockLog.info).toHaveBeenCalledWith("wrun_1 had already finished");
  });
});

describe("--agent targets a server the caller is running themselves", () => {
  /**
   * The whole capability, and the one thing a reader cannot check by eye: a dev
   * server mounts the workflow API on the ORIGIN, where the platform serves it
   * under `/:slug`. So the platform URL is not this URL with a different host —
   * the slug segment is ABSENT, which is why no `--server` value could reach a
   * dev server and why `aai dev` was unreachable from this command at all.
   */
  test("builds a slug-LESS base URL, not the platform's /:slug shape", async () => {
    fetchMock.mockImplementation(async () => json({ workflows: [] }));
    await executeWorkflowList("/proj", { agent: "http://localhost:3000" });
    expect(call()[0]).toBe("http://localhost:3000/workflows");
  });

  test("resolves NO project config and NO API key", async () => {
    // The two things that made `aai dev` unreachable. `getServerInfo` resolves
    // the key BEFORE it looks for a slug, so an undeployed project's first
    // error was `not_logged_in` — pointing at `aai login` for a command that
    // never sends the key. Asserted on the mocks rather than on the URL,
    // because a URL assertion passes whether or not either was consulted.
    fetchMock.mockImplementation(async () => json({ workflows: [] }));
    await executeWorkflowList("/proj", { agent: "http://localhost:3000" });
    expect(getServerInfo).not.toHaveBeenCalled();
    expect(mockReadProjectConfig).not.toHaveBeenCalled();
  });

  test("still sends no authorization, and still honours --token", async () => {
    // Same posture as the platform path: the workflow API is the agent's own
    // surface. A local target must not become an excuse to send a credential.
    fetchMock.mockImplementation(async () => json({ workflows: [] }));
    await executeWorkflowList("/proj", { agent: "http://localhost:3000" });
    expect(new Headers(call()[1].headers).get("authorization")).toBe(null);

    fetchMock.mockClear();
    await executeWorkflowList("/proj", { agent: "http://localhost:3000", token: "t0k" });
    expect(new Headers(call()[1].headers).get("authorization")).toBe("Bearer t0k");
  });

  test("strips a trailing slash, so the joined path has no empty segment", async () => {
    // `resolveServerUrl` does this for every OTHER origin reaching this module,
    // at resolution time — `--agent` is the one it does not produce, so the
    // strip is owned here rather than at the join.
    fetchMock.mockImplementation(async () => json({ workflows: [] }));
    await executeWorkflowList("/proj", { agent: "http://localhost:3000///" });
    expect(call()[0]).toBe("http://localhost:3000/workflows");
  });

  test("names the ORIGIN when the agent declares nothing", async () => {
    // There is no slug to print, and "undefined declares no workflows" is what
    // a `slug`-shaped Target would have produced.
    fetchMock.mockImplementation(async () => json({ workflows: [] }));
    await executeWorkflowList("/proj", { agent: "http://localhost:3000" });
    expect(mockLog.info).toHaveBeenCalledWith("http://localhost:3000 declares no workflows");
  });

  test.each([
    ["not a URL at all", "localhost:3000"],
    ["a non-HTTP scheme", "ftp://localhost:3000"],
    ["a file URL", "file:///etc/passwd"],
  ])("refuses %s before it reaches a request", async (_label, value) => {
    // This value is joined into a request path, so it is checked at the point it
    // becomes a target rather than interpolated — the rule
    // `resolveDeployTarget`'s slug guard follows. The assertion that matters is
    // that NOTHING was dialled.
    await expect(executeWorkflowList("/proj", { agent: value })).rejects.toThrow(/--agent/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a project with no deployment", () => {
  test("names the cause FIRST, and both ways out", async () => {
    // The reproduction: `aai workflow list` in an undeployed project reported
    // `not_logged_in` when the caller was not logged in, and "run `aai publish`
    // first" when they were — neither naming `aai dev`, whose workflow API was
    // answering on localhost the whole time. The credential is never resolved
    // on this path now, so the sentence cannot be pre-empted by a login error.
    mockReadProjectConfig.mockResolvedValue(null);
    await expect(executeWorkflowList("/proj", {})).rejects.toMatchObject({
      code: "no_deployment",
      hint: expect.stringContaining("--agent"),
    });
    expect(getServerInfo).not.toHaveBeenCalled();
  });

  test("a config with no slug is the same case as no config", async () => {
    // `aai pull` of a never-published project, and `aai delete`, both leave a
    // project.json that keeps `serverUrl` and carries no slug.
    mockReadProjectConfig.mockResolvedValue({ serverUrl: "https://agents.example" });
    await expect(executeWorkflowList("/proj", {})).rejects.toMatchObject({
      code: "no_deployment",
    });
  });
});
