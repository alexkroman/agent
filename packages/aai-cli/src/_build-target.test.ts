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
  DENO_ENTRY_SOURCE,
  isBuildTarget,
  MODAL_ENTRY_SOURCE,
  MODAL_PORT,
  resolveBuildTarget,
  TARGET_ENV_MARKERS,
  VERCEL_BUILD_CONFIG_SOURCE,
  VERCEL_ENTRY_SOURCE,
  VERCEL_FUNCTION_DIR,
  VERCEL_FUNCTION_ROUTE,
  vercelFunctionConfigSource,
  vercelNodeRuntime,
} from "./_build-target.ts";

describe("resolveBuildTarget", () => {
  test("a laptop with no host markers gets the default, which emits nothing", () => {
    expect(resolveBuildTarget(undefined, {})).toBe(DEFAULT_BUILD_TARGET);
    // The whole point of the default: an existing project's build is unchanged.
    expect(DEFAULT_BUILD_TARGET).toBe("node");
  });

  test("deno is reachable by flag, and refuses nothing it accepts", () => {
    expect(resolveBuildTarget("deno", {})).toBe("deno");
    expect(isBuildTarget("deno")).toBe(true);
    expect(BUILD_TARGETS).toContain("deno");
  });

  test("modal is reachable by flag ONLY, and no environment reaches it", () => {
    expect(resolveBuildTarget("modal", {})).toBe("modal");
    expect(isBuildTarget("modal")).toBe(true);
    // `modal deploy` uploads a directory built on the developer's machine, so
    // no build ever runs on Modal's infrastructure and any marker would be dead
    // config. The two variables that DO exist in a Modal environment are set
    // inside a container — `MODAL_IS_REMOTE`, `MODAL_TASK_ID` — which is the
    // wrong end, and dangerously so here: this repo's own guest sandboxes are
    // Modal Sandboxes and studio Publish runs the CLI inside one, so detecting
    // on them would flip the platform's own build to this target.
    expect(resolveBuildTarget(undefined, { MODAL_IS_REMOTE: "1" })).toBe(DEFAULT_BUILD_TARGET);
    expect(resolveBuildTarget(undefined, { MODAL_TASK_ID: "ta-123" })).toBe(DEFAULT_BUILD_TARGET);
    // Credentials are not a statement about what this build is FOR: a developer
    // with these exported would otherwise get Modal output from a Vercel build.
    expect(resolveBuildTarget(undefined, { MODAL_TOKEN_ID: "ak-1" })).toBe(DEFAULT_BUILD_TARGET);
  });

  test("the host's own build container is detected with no flag", () => {
    // Vercel sets this on every build and deployment, so a project deployed
    // from a git push needs nothing configured — Nitro's zero-config property.
    expect(resolveBuildTarget(undefined, { VERCEL: "1" })).toBe("vercel");
    // Deno Deploy's documented marker. Note the flag is the path that matters
    // for this target — `deno deploy` uploads a directory built on the
    // developer's own machine — so detection is convenience, not the mechanism.
    expect(resolveBuildTarget(undefined, { DENO_DEPLOY: "true" })).toBe("deno");
    // Both of Deno Deploy's markers, because neither covers both GENERATIONS
    // of the platform: Classic sets `DENO_DEPLOYMENT_ID` and no `DENO_DEPLOY`,
    // so reading only the latter left Classic undetectable. Asserted separately
    // from the map-consistency test below, which derives from
    // `TARGET_ENV_MARKERS` and so cannot notice a missing key.
    expect(resolveBuildTarget(undefined, { DENO_DEPLOYMENT_ID: "abc123" })).toBe("deno");
  });

  test("an explicit target beats the environment, in both directions", () => {
    expect(resolveBuildTarget("node", { VERCEL: "1" })).toBe("node");
    expect(resolveBuildTarget("vercel", {})).toBe("vercel");
  });

  test("the accepted list in the error names every target", () => {
    // The message is the only place a user learns what exists, so a target
    // added without reaching this list is a target nobody can discover.
    for (const target of BUILD_TARGETS) {
      expect(() => resolveBuildTarget("netlify", {})).toThrow(new RegExp(target));
    }
  });

  test("an unknown target is REFUSED, naming what is accepted", () => {
    // Never a fallback to the default: a typo that quietly built `node` would
    // deploy a project missing the entry its host needs, and the failure would
    // arrive as a 404 from the platform rather than an error from the build.
    expect(() => resolveBuildTarget("netlify", {})).toThrow(/Unknown build target "netlify"/);
    expect(() => resolveBuildTarget("netlify", {})).toThrow(/node, vercel, deno, modal/);
  });

  test("an empty marker value does not count as being on that host", () => {
    // `VERCEL=` in a shell is how somebody unsets it; reading it as truthy
    // would emit a Vercel entry on a laptop.
    expect(resolveBuildTarget(undefined, { VERCEL: "" })).toBe(DEFAULT_BUILD_TARGET);
  });

  test("every marker names a real target, and every target is REACHABLE", () => {
    // A marker naming a target that does not exist is dead detection.
    for (const target of Object.values(TARGET_ENV_MARKERS)) {
      expect(BUILD_TARGETS).toContain(target);
    }
    // Reachability is the invariant that matters, and the FLAG is what carries
    // it. This used to demand a marker per non-default target, which reads as
    // the same claim and is not: it forces a host whose deploy step uploads a
    // locally-built directory — `modal deploy`, and `deno deploy` in its
    // ordinary flow — to invent a variable no build ever sees. A target
    // nothing can select is the real failure, so that is what is asserted.
    for (const target of BUILD_TARGETS) {
      expect(resolveBuildTarget(target, {})).toBe(target);
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
    expect(config.routes).toEqual([
      { handle: "filesystem" },
      { src: "/(.*)", dest: VERCEL_FUNCTION_ROUTE },
    ]);
  });

  test("the function's route cannot be claimed by a static file", () => {
    // The Build Output API derives the route from the directory name, so the
    // name is a URL. `index.func` served at `/index` took `/` from the static
    // index.html on a real preview deployment — every other asset was fine and
    // the home page 500'd. A `__` prefix is not a path any bundler emits.
    expect(VERCEL_FUNCTION_DIR.endsWith(`${VERCEL_FUNCTION_ROUTE.slice(1)}.func`)).toBe(true);
    expect(VERCEL_FUNCTION_ROUTE).toMatch(/^\/__/);
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

describe("the emitted Deno entry", () => {
  const code = DENO_ENTRY_SOURCE.split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  test("BINDS, which every other target's entry must not", () => {
    // The one target whose host runs a long-lived process and expects it to
    // listen. Vercel's entry is a `(req, res)` handler and calling `listen()`
    // there would bind a port inside a function and serve nothing.
    expect(code).toMatch(/await server\.listen\(/);
    expect(code).toContain("createProjectServer");
  });

  test("binds 0.0.0.0, not the loopback default", () => {
    // `AgentServer.listen` defaults to loopback deliberately — it has no
    // request auth of its own — so a host that reaches the process from
    // outside has to say so, and a deployment that did not would answer
    // nothing while looking healthy.
    expect(code).toContain('"0.0.0.0"');
  });

  test("resolves its artifacts from the MODULE, not the process", () => {
    // `.aai/` is copied in beside this file; the working directory belongs to
    // the platform.
    expect(code).toContain("import.meta.dirname");
    expect(code).not.toContain("process.cwd()");
  });

  test("reaches Deno's env through globalThis", () => {
    // This file is bundled by a Node-side build and read by Node tooling —
    // this spec included — where a bare `Deno` is a ReferenceError.
    expect(code).toContain("globalThis.Deno?.env");
  });

  test("says it is generated, since it lands in a user's project", () => {
    expect(DENO_ENTRY_SOURCE).toMatch(/Generated by/);
    expect(DENO_ENTRY_SOURCE).toMatch(/do not edit/i);
  });
});

describe("the emitted Modal entry", () => {
  const code = MODAL_ENTRY_SOURCE.split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  test("BINDS, like Deno's and unlike Vercel's", () => {
    // `@modal.web_server` runs a container command and proxies to a port that
    // command opens, so this is the long-lived `aai start` shape.
    expect(code).toMatch(/await server\.listen\(/);
    expect(code).toContain("createProjectServer");
  });

  test("binds 0.0.0.0, not the loopback default", () => {
    // Modal's proxy reaches this from outside the process, so a loopback bind
    // answers nothing while the container looks healthy.
    expect(code).toContain('"0.0.0.0"');
  });

  test("reads the port app.py routes to, from the environment app.py sets", () => {
    // The image bakes PORT and the decorator routes to it. The literal here is
    // the fallback for a container started without it.
    expect(code).toContain("process.env.PORT");
    expect(code).toContain(String(MODAL_PORT));
    // Node's own env, not Deno's — this entry is never bundled for Deploy.
    expect(code).not.toContain("globalThis.Deno");
  });

  test("resolves its artifacts from the MODULE, not the process", () => {
    // `.aai/` is copied in beside this file; the working directory belongs to
    // the platform.
    expect(code).toContain("import.meta.dirname");
    expect(code).not.toContain("process.cwd()");
  });

  test("DRAINS on a signal, which the Deno entry does not", () => {
    // Modal stops a container on every scale-in and every redeploy, which for
    // a voice agent is a live call being cut. `close()` shuts the runtime down
    // with it, so sessions end rather than sockets dropping. app.py forwards
    // the signal and waits; this is the half that acts on it.
    expect(code).toMatch(/\["SIGINT", "SIGTERM"\]/);
    expect(code).toContain("server.close()");
    // Synchronous, for the reason `executeStart` documents: an async listener
    // hands its promise to `process`, which discards it, so a failed shutdown
    // would surface as an unhandled rejection instead of a non-zero exit.
    expect(code).not.toMatch(/process\.once\([^)]*async/);
    expect(DENO_ENTRY_SOURCE).not.toContain("server.close()");
  });

  test("says it is generated, since it lands in a user's project", () => {
    expect(MODAL_ENTRY_SOURCE).toMatch(/Generated by/);
    expect(MODAL_ENTRY_SOURCE).toMatch(/do not edit/i);
  });
});
