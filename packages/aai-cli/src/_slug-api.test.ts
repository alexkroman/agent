// Copyright 2026 the AAI authors. MIT license.
// The slug-scoped request shape every per-agent command shares
// (_slug-api.ts): which URL it builds, and the "not deployed" 404 hint it
// attaches. Both collaborators are faked through `PlatformDeps`.

import { describe, expect, test, vi } from "vitest";
import { HINT_NOT_DEPLOYED } from "./_api-client.ts";
import { type PlatformDeps, secretRequest, slugRequest, slugRequestOn } from "./_slug-api.ts";

type ServerInfo = Awaited<ReturnType<PlatformDeps["getServerInfo"]>>;

/** A platform whose target is `info` and whose every request answers `reply`. */
function fakePlatform(info: Partial<ServerInfo> = {}, reply: unknown = { ok: true }) {
  // Untyped, as `logs.test.ts`'s is: `apiRequest` is generic in its result,
  // which no concrete fake can be.
  const apiRequest = vi.fn().mockResolvedValue(reply);
  const getServerInfo = vi.fn(async () => ({
    serverUrl: "https://platform.example",
    slug: "my-agent",
    apiKey: "key-1",
    studioProject: undefined,
    ...info,
  }));
  return {
    platform: { getServerInfo, apiRequest } satisfies PlatformDeps,
    apiRequest,
    getServerInfo,
  };
}

/** The URL and options of the one request made; throws unless exactly one was. */
function onlyRequest(apiRequest: ReturnType<typeof fakePlatform>["apiRequest"]) {
  const { calls } = apiRequest.mock;
  if (calls.length !== 1) throw new Error(`expected one request, saw ${calls.length}`);
  const [url, opts] = calls[0] ?? [];
  return { url: String(url), opts };
}

describe("secretRequest", () => {
  test("an unlinked directory targets the bare slug", async () => {
    const { platform, apiRequest } = fakePlatform();
    const result = await secretRequest(
      "/proj",
      "",
      { method: "GET", action: "secret" },
      undefined,
      platform,
    );
    const { url, opts } = onlyRequest(apiRequest);
    expect(url).toBe("https://platform.example/my-agent/secret");
    expect(opts).toMatchObject({ method: "GET", action: "secret", apiKey: "key-1" });
    expect(result).toEqual({ data: { ok: true }, target: "my-agent" });
  });

  test("a studio-linked directory routes to the PROJECT, which fans out to both agents", async () => {
    // Writing the production slug alone left the preview agent without the key.
    const { platform, apiRequest } = fakePlatform({ studioProject: "my project" });
    const result = await secretRequest(
      "/proj",
      "/API_KEY",
      { method: "DELETE", action: "secret" },
      undefined,
      platform,
    );
    const { url } = onlyRequest(apiRequest);
    // The project name comes from the working tree, so it is encoded.
    expect(url).toBe("https://platform.example/studio/projects/my%20project/secret/API_KEY");
    expect(result.target).toBe("my project");
  });

  test("passes an explicit server through to target resolution", async () => {
    const { platform, getServerInfo } = fakePlatform();
    await secretRequest("/proj", "", { action: "secret" }, "https://other.example", platform);
    expect(getServerInfo).toHaveBeenCalledWith("/proj", "https://other.example");
  });
});

describe("slugRequestOn / slugRequest", () => {
  test("every request carries the not-deployed 404 hint", async () => {
    const { platform, apiRequest } = fakePlatform();
    await slugRequestOn(
      { serverUrl: "https://platform.example", slug: "s", apiKey: "k" },
      "/logs",
      { action: "logs" },
      platform,
    );
    expect(onlyRequest(apiRequest).opts).toMatchObject({
      apiKey: "k",
      hints: { 404: HINT_NOT_DEPLOYED },
    });
  });

  test("slugRequestOn uses the target it is handed and resolves nothing", async () => {
    const { platform, apiRequest, getServerInfo } = fakePlatform();
    await slugRequestOn(
      { serverUrl: "https://a.example", slug: "polled", apiKey: "k" },
      "/logs?after=3",
      { action: "logs" },
      platform,
    );
    expect(onlyRequest(apiRequest).url).toBe("https://a.example/polled/logs?after=3");
    expect(getServerInfo).not.toHaveBeenCalled();
  });

  test("slugRequest resolves the target, then reports the slug it used", async () => {
    const { platform, apiRequest } = fakePlatform({}, { vars: ["A"] });
    const result = await slugRequest(
      "/proj",
      "/storage",
      { method: "POST", action: "storage" },
      undefined,
      platform,
    );
    expect(onlyRequest(apiRequest).url).toBe("https://platform.example/my-agent/storage");
    expect(result).toEqual({ data: { vars: ["A"] }, slug: "my-agent" });
  });
});
