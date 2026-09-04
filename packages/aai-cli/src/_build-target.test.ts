// Copyright 2026 the AAI authors. MIT license.
/**
 * `resolveBuildTarget` and the sources it emits.
 *
 * The property worth pinning is the PRECEDENCE, because two of its three arms
 * are invisible at a call site: a laptop build must not pick up a host target,
 * and a build ON a host must not need a flag the user has nowhere to pass. The
 * emitted sources are asserted for the two claims that make them work at all —
 * a default export and no `listen()`.
 */

import { describe, expect, test } from "vitest";
import {
  BUILD_TARGETS,
  DEFAULT_BUILD_TARGET,
  isBuildTarget,
  resolveBuildTarget,
  TARGET_ENV_MARKERS,
  VERCEL_BUILD_CONFIG_SOURCE,
  VERCEL_ENTRY_SOURCE,
  vercelFunctionConfigSource,
  vercelNodeRuntime,
} from "./_build-target.ts";

describe("resolveBuildTarget", () => {
  test("a laptop with no host markers gets the default, which emits nothing", () => {
    expect(resolveBuildTarget(undefined, {})).toBe(DEFAULT_BUILD_TARGET);
    // The whole point of the default: an existing project's build is unchanged.
    expect(DEFAULT_BUILD_TARGET).toBe("node");
  });

  test("the host's own build container is detected with no flag", () => {
    // Vercel sets this on every build and deployment, so a project deployed
    // from a git push needs nothing configured — Nitro's zero-config property.
    expect(resolveBuildTarget(undefined, { VERCEL: "1" })).toBe("vercel");
  });

  test("an explicit target beats the environment, in both directions", () => {
    expect(resolveBuildTarget("node", { VERCEL: "1" })).toBe("node");
    expect(resolveBuildTarget("vercel", {})).toBe("vercel");
  });

  test("an unknown target is REFUSED, naming what is accepted", () => {
    // Never a fallback to the default: a typo that quietly built `node` would
    // deploy a project missing the entry its host needs, and the failure would
    // arrive as a 404 from the platform rather than an error from the build.
    expect(() => resolveBuildTarget("netlify", {})).toThrow(/Unknown build target "netlify"/);
    expect(() => resolveBuildTarget("netlify", {})).toThrow(/node, vercel/);
  });

  test("an empty marker value does not count as being on that host", () => {
    // `VERCEL=` in a shell is how somebody unsets it; reading it as truthy
    // would emit a Vercel entry on a laptop.
    expect(resolveBuildTarget(undefined, { VERCEL: "" })).toBe(DEFAULT_BUILD_TARGET);
  });

  test("every marker names a real target, and every target but the default is reachable", () => {
    // A marker naming a target that does not exist is dead detection, and a
    // target no marker and no flag can reach is a shape nobody can build.
    for (const target of Object.values(TARGET_ENV_MARKERS)) {
      expect(BUILD_TARGETS).toContain(target);
    }
    const detectable = new Set(Object.values(TARGET_ENV_MARKERS));
    for (const target of BUILD_TARGETS) {
      if (target === DEFAULT_BUILD_TARGET) continue;
      expect(detectable.has(target)).toBe(true);
    }
  });

  test("isBuildTarget narrows only the declared set", () => {
    expect(isBuildTarget("vercel")).toBe(true);
    expect(isBuildTarget("netlify")).toBe(false);
  });
});

describe("the emitted Vercel entry", () => {
  const code = VERCEL_ENTRY_SOURCE.split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  test("default-exports a request HANDLER, and never calls listen", () => {
    // The Build Output API has no builder in the path: `launcherType: "Nodejs"`
    // invokes the default export per request. An `http.Server` there is never
    // bound and serves nothing — which is why this is not the `export default
    // server` shape `@vercel/node` accepts.
    expect(code).toMatch(/export default function handler\(req, res\)/);
    // Comments are stripped above: the file explains that it does not call
    // listen(), so a naive match reads its own explanation as the thing.
    expect(code).not.toMatch(/\blisten\s*\(/);
    // Through the published subpath, not a relative path: this file is bundled
    // from inside a user's project, where `./start.ts` means nothing.
    expect(VERCEL_ENTRY_SOURCE).toContain('from "@alexkroman1/aai-cli/start"');
  });

  test("a WebSocket upgrade is re-emitted onto the server, not handled here", () => {
    // Vercel delivers the raw upgrade through its per-request context rather
    // than as an event. Everything downstream — auth, the session, /phone — is
    // registered on the `http.Server`'s own `upgrade` listener, so translating
    // must end in an `emit` and never in a second WebSocket implementation
    // that would drift from the one `aai dev` and `aai start` run.
    expect(code).toContain('Symbol.for("@vercel/request-context")');
    expect(code).toMatch(/upgradeWebSocket\?\.\(\)/);
    expect(code).toMatch(/server\.emit\("upgrade", upgrade\.req, upgrade\.socket, upgrade\.head\)/);
    expect(code).toMatch(/server\.emit\("request", req, res\)/);
  });

  test("a non-upgrade request is never answered with the 204", () => {
    // The 204 ends the INVOCATION once the socket has been handed off; the
    // agent talks on `upgrade.socket`, not on this `res`. Emitting it on an
    // ordinary request would answer every page load with an empty body.
    const upgradeArm = code.slice(
      code.indexOf("if (upgrade)"),
      code.indexOf('server.emit("request"'),
    );
    expect(upgradeArm).toContain("res.statusCode = 204");
    expect(code.slice(code.indexOf('server.emit("request"'))).not.toContain("204");
  });

  test("says it is generated, since it lands in a user's project", () => {
    expect(VERCEL_ENTRY_SOURCE).toMatch(/Generated by/);
    expect(VERCEL_ENTRY_SOURCE).toMatch(/do not edit/i);
  });
});

describe("the emitted Build Output API config", () => {
  test("static files are served before anything reaches the function", () => {
    const config = JSON.parse(VERCEL_BUILD_CONFIG_SOURCE) as {
      version: number;
      routes: { handle?: string; src?: string; dest?: string }[];
    };
    expect(config.version).toBe(3);
    // Order is the whole meaning of this table: `handle: filesystem` first is
    // what lets the CDN answer for the client bundle, and the catch-all after
    // it is what keeps /client-config, /websocket, /workflows/* and the webhook
    // route reaching the agent. Reversed, every asset costs an invocation.
    expect(config.routes).toEqual([{ handle: "filesystem" }, { src: "/(.*)", dest: "/index" }]);
  });

  test("the function config names the entry and keeps streaming on", () => {
    const config = JSON.parse(vercelFunctionConfigSource("nodejs22.x")) as Record<string, unknown>;
    expect(config.handler).toBe("index.mjs");
    expect(config.launcherType).toBe("Nodejs");
    expect(config.runtime).toBe("nodejs22.x");
    // An agent streams TTS audio and SSE workflow events. Buffered to
    // completion, a stream that ends when the call does never arrives.
    expect(config.supportsResponseStreaming).toBe(true);
  });

  test("the runtime is clamped to a version Vercel actually offers", () => {
    // A build on a Node newer than the platform's newest must not name a
    // runtime the deployment will be rejected for.
    expect(vercelNodeRuntime("22.14.0")).toBe("nodejs22.x");
    expect(vercelNodeRuntime("23.1.0")).toBe("nodejs22.x");
    expect(vercelNodeRuntime("26.0.0")).toBe("nodejs24.x");
    expect(vercelNodeRuntime("18.20.0")).toBe("nodejs20.x");
  });
});
