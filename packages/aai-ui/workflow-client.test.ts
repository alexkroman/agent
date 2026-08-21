// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/**
 * Specs for the browser workflow client.
 *
 * What is left to assert here is the one thing this module still decides: the
 * BASE URL. Every route, query, bearer and status rule moved to the SDK with the
 * implementation (`aai/sdk/workflow-api-client.test.ts` owns them now), so
 * re-asserting them would be a second copy of the coverage a second copy of the
 * client was just deleted for.
 *
 * jsdom, because the default base URL IS `location` — which is the whole reason
 * this wrapper exists: the SDK client requires a base URL, having no `location`
 * to fall back on.
 *
 * The hook that drives the client in a loop is specced in
 * `use-workflow-run.test.ts`.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { createWorkflowApi } from "./workflow-client.ts";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ workflows: [] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

/** The URL of the request the client made. */
function url(): string {
  return String((fetchMock.mock.calls[0] as [string, RequestInit | undefined])[0]);
}

describe("createWorkflowApi", () => {
  test("defaults to the page's own origin and path — the agent serving it", async () => {
    await createWorkflowApi().list();
    expect(url()).toBe(`${location.origin}${location.pathname}workflows`);
  });

  test("an explicit base URL wins, with or without a trailing slash", async () => {
    await createWorkflowApi({ baseUrl: "https://agents.example/my-agent" }).list();
    expect(url()).toBe("https://agents.example/my-agent/workflows");

    fetchMock.mockClear();
    await createWorkflowApi({ baseUrl: "https://agents.example/my-agent/" }).list();
    expect(url()).toBe("https://agents.example/my-agent/workflows");
  });

  test("a token reaches the SDK client, so it rides the request as a bearer", async () => {
    await createWorkflowApi({ baseUrl: "https://agents.example/a", token: "s3cret" }).list();
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(init.headers).toMatchObject({ Authorization: "Bearer s3cret" });
  });

  test("no token means no authorization header — a public page has none to send", async () => {
    await createWorkflowApi({ baseUrl: "https://agents.example/a" }).list();
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(init.headers).toEqual({});
  });

  test("the whole call set is present, so a page cannot find a verb missing", async () => {
    // The methods are the SDK's; what this pins is that the wrapper returns the
    // client rather than a narrowed subset of it, which is precisely what each of
    // the three hand-written copies was.
    const api = createWorkflowApi({ baseUrl: "https://agents.example/a" });
    expect(Object.keys(api).sort()).toEqual([
      "cancel",
      "download",
      "find",
      "follow",
      "followOutput",
      "get",
      "list",
      "recent",
      "start",
      "startAndWait",
      "streamOutput",
      "upload",
      "uploadInfo",
      "uploadStream",
      "wake",
      "watch",
    ]);
  });
});
