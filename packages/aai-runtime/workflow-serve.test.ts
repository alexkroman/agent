// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the guest's workflow loading.
 *
 * The rewriting is what these are really about. It is the one piece here that
 * fails SILENTLY when it is subtly wrong — a specifier rewritten to a path that
 * does not exist, or one left bare that needed rewriting, both surface as
 * `ERR_MODULE_NOT_FOUND` from `/tmp` with nothing pointing back at this file.
 */

import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { requestPath } from "@alexkroman1/aai/host-internal";
import { describe, expect, test, vi } from "vitest";
import {
  createWorkflowSurface,
  handleWorkflowRequest,
  isLoopbackAddress,
  loadWorkflowModule,
  rewriteWorkflowImports,
  WORKFLOW_FLOW_PATH,
  WORKFLOW_STEP_PATH,
  WORKFLOW_WEBHOOK_PREFIX,
  type WorkflowSurface,
  webhookToken,
} from "./workflow-serve.ts";

describe("rewriteWorkflowImports", () => {
  test("rewrites a bare DevKit import to an absolute file URL", () => {
    const out = rewriteWorkflowImports(`import { sleep } from "workflow";\n`);
    expect(out).toMatch(/^import \{ sleep \} from "file:\/\/\//);
    expect(out).toContain("/workflow/");
  });

  test("rewrites every specifier the builder actually emits", () => {
    // Measured against real artifacts: the step bundle imports exactly
    // `workflow`, `workflow/internal/private` and `workflow/runtime`, and the
    // flow bundle only `workflow/runtime`. Everything else is inlined.
    for (const spec of ["workflow", "workflow/internal/private", "workflow/runtime"]) {
      const out = rewriteWorkflowImports(`import x from "${spec}";`);
      expect(out, spec).toMatch(/from "file:\/\/\//);
    }
  });

  test("rewrites a side-effect import, which is the shape the step bundle uses", () => {
    // `import "workflow/internal/private"` has no `from`, so a rewrite keyed
    // only on `from` would miss the one form that matters most here.
    const out = rewriteWorkflowImports(`import "workflow/internal/builtins";`);
    expect(out).toMatch(/^import "file:\/\/\//);
  });

  test("leaves the agent's own bundled imports alone", () => {
    // Everything but the DevKit is inlined by the builder, so a bare specifier
    // that is NOT the DevKit means a bundling bug — rewriting it would hide one.
    const code = `import a from "node:fs";\nimport b from "./local.js";\nimport c from "zod";`;
    expect(rewriteWorkflowImports(code)).toBe(code);
  });

  test("leaves a matching string that is not an import specifier alone", () => {
    // The transform emits step ids as string literals, and they contain the
    // word. A blunter replace would corrupt the registry keys.
    const code = `registerStepFunction("step//./workflows/x//go", go);`;
    expect(rewriteWorkflowImports(code)).toBe(code);
  });

  test("leaves an unresolvable specifier as-is rather than mangling it", () => {
    // `@workflow/*` is in the rewritable set defensively — the builder does not
    // emit one today, and those packages are not direct dependencies here. If it
    // ever starts, this is the behaviour that makes it diagnosable: the import
    // survives and fails at load with Node's own error naming the module, rather
    // than being rewritten to a path that resolves to nothing.
    const code = `import x from "@workflow/not-installed-here";`;
    expect(rewriteWorkflowImports(code)).toBe(code);
  });

  test("resolves the root entry the way an IMPORT does, not a require", async () => {
    // `workflow`'s root maps `require` to its TypeScript plugin, so resolving
    // with require semantics rewrites to a CJS module that dies on
    // `typescript/lib/tsserverlibrary`. Importing the rewritten URL is the only
    // assertion that catches it.
    const out = rewriteWorkflowImports(`import x from "workflow";`);
    const url = /"(file:\/\/[^"]+)"/.exec(out)?.[1];
    expect(url).toBeDefined();
    expect(url).not.toContain("typescript-plugin");
    await expect(import(url as string)).resolves.toBeDefined();
  });

  test("handles single quotes and irregular spacing", () => {
    const out = rewriteWorkflowImports(`import {a} from  'workflow/api'`);
    expect(out).toMatch(/from {2}'file:\/\/\//);
  });
});

describe("loadWorkflowModule", () => {
  test("evaluates the bundle, which is what registers its steps", async () => {
    // Registration is a top-level side effect and the module's exports are
    // never read, so evaluation IS the contract.
    const marker = `aai-step-load-${Date.now()}`;
    await loadWorkflowModule(`globalThis[${JSON.stringify(marker)}] = true;`, "steps");
    expect((globalThis as Record<string, unknown>)[marker]).toBe(true);
    delete (globalThis as Record<string, unknown>)[marker];
  });

  test("loads a bundle whose DevKit import had to be rewritten", async () => {
    // The end-to-end shape: a bare import that would fail from /tmp untouched.
    const marker = `aai-step-wdk-${Date.now()}`;
    await loadWorkflowModule(
      `import { sleep } from "workflow";\n` +
        `globalThis[${JSON.stringify(marker)}] = typeof sleep;`,
      "steps",
    );
    expect((globalThis as Record<string, unknown>)[marker]).toBe("function");
    delete (globalThis as Record<string, unknown>)[marker];
  });

  test("a second load of different code is not served from the module cache", async () => {
    const a = `aai-step-a-${Date.now()}`;
    const b = `aai-step-b-${Date.now()}`;
    await loadWorkflowModule(`globalThis[${JSON.stringify(a)}] = 1;`, "steps");
    await loadWorkflowModule(`globalThis[${JSON.stringify(b)}] = 2;`, "steps");
    // Node caches by URL, so a fixed temp path would silently serve the first
    // bundle for the rest of the process — which in the studio's build→load
    // loop means testing the code you just replaced.
    expect((globalThis as Record<string, unknown>)[b]).toBe(2);
    delete (globalThis as Record<string, unknown>)[a];
    delete (globalThis as Record<string, unknown>)[b];
  });

  test("returns the module's exports, which is where the route handler is", async () => {
    // Both builder outputs are ROUTE MODULES exporting POST — see the module
    // doc. Handing the flow module's own source to `workflowEntrypoint` instead
    // compiles it in a `node:vm` Script and every run dies at replay on
    // "Cannot use import statement outside a module".
    const mod = await loadWorkflowModule(`export const POST = () => "ok";`, "flows");
    expect(typeof mod.POST).toBe("function");
  });
});

describe("createWorkflowSurface", () => {
  test("mounts nothing when the agent declares no workflows", async () => {
    // Both halves are required: a project with no `workflows/` directory gets
    // neither export, and half of one would be a bundling bug rather than an
    // agent that should serve routes answering 500.
    await expect(createWorkflowSurface(undefined, undefined)).resolves.toBeUndefined();
    await expect(
      createWorkflowSurface("export const POST = () => 1;", undefined),
    ).resolves.toBeUndefined();
  });

  test("fails naming the bundle when a route module exports no POST", async () => {
    await expect(
      createWorkflowSurface("export const NOPE = 1;", "export const POST = () => 1;"),
    ).rejects.toThrow(/flow bundle exported no POST/);
  });
});

describe("webhookToken", () => {
  test("extracts the token from a webhook path", () => {
    expect(webhookToken("/.well-known/workflow/v1/webhook/abc123")).toBe("abc123");
  });

  test("percent-decodes it", () => {
    expect(webhookToken("/.well-known/workflow/v1/webhook/a%2Fb")).toBe("a/b");
  });

  test("rejects an empty trailing segment", () => {
    // A webhook URL is handed out of the system, so the token IS the
    // authorization; an empty one must not reach the DevKit as a lookup.
    expect(webhookToken("/.well-known/workflow/v1/webhook/")).toBeUndefined();
  });

  test("rejects a multi-segment tail rather than joining it", () => {
    expect(webhookToken("/.well-known/workflow/v1/webhook/a/b")).toBeUndefined();
  });

  test("returns undefined for any other path", () => {
    expect(webhookToken("/.well-known/workflow/v1/flow")).toBeUndefined();
    expect(webhookToken("/health")).toBeUndefined();
  });

  test.each([
    ["a lone percent", "%"],
    ["a truncated escape", "%A"],
    ["a non-hex escape", "%zz"],
    ["an overlong UTF-8 sequence", "%C0%80"],
  ])("declines %s instead of throwing", (_label, token) => {
    // `decodeURIComponent` raises URIError on every one of these, and this whole
    // call chain is synchronous — see the module doc on `_path-decode.ts`.
    expect(() => webhookToken(`${WORKFLOW_WEBHOOK_PREFIX}${token}`)).not.toThrow();
    expect(webhookToken(`${WORKFLOW_WEBHOOK_PREFIX}${token}`)).toBeUndefined();
  });
});

/**
 * Serve `surface` from a REAL http server and return its base URL.
 *
 * A real server rather than fakes for node's `IncomingMessage`/`ServerResponse`:
 * the adapter's whole job is turning those into a `Request` and a `Response`
 * back again, and a hand-built pair proves nothing about the types the code
 * actually meets — it also cannot be constructed without casting, which is the
 * signal that the fake is the wrong tool.
 */
async function serving(
  surface: WorkflowSurface | null | undefined,
  // Every interface, for the one spec that has to arrive from off-box. Loopback
  // otherwise, which is what the rest of these are about.
  host = "127.0.0.1",
): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = requestPath(req.url);
    if (!handleWorkflowRequest(surface, req, res, url, req.method ?? "GET")) {
      res.writeHead(404);
      res.end("unclaimed");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * This host's first non-loopback IPv4 address, or undefined when it has none.
 *
 * The gate's whole claim is about a peer that is NOT loopback, and the only way
 * to produce one without a second machine is to dial this host by an address
 * that is not `127.0.0.0/8` — which needs a real interface. A container with
 * only `lo` legitimately has none, so the spec that needs this ANNOUNCES its
 * skip rather than passing vacuously.
 */
function firstExternalIpv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return undefined;
}

function surfaceOf(over: Partial<WorkflowSurface> = {}): WorkflowSurface {
  return {
    flow: vi.fn(async () => new Response("flow", { status: 200 })),
    step: vi.fn(async () => new Response("step", { status: 200 })),
    webhook: vi.fn(async () => new Response("hook", { status: 200 })),
    ...over,
  };
}

describe("handleWorkflowRequest", () => {
  // Mounting routes that answer 500 would be worse than not mounting them:
  // the queue retries a 5xx, so it would retry forever.
  test.each([
    ["undefined", undefined],
    ["null", null],
  ])(
    "declines every request when the agent declares no workflows (%s)",
    async (_label, surface) => {
      const s = await serving(surface);
      const res = await fetch(`${s.url}${WORKFLOW_FLOW_PATH}`, { method: "POST" });
      expect(res.status).toBe(404);
      await s.close();
    },
  );

  test("routes POST /flow to the flow handler and writes its response back", async () => {
    const surface = surfaceOf();
    const s = await serving(surface);
    const res = await fetch(`${s.url}${WORKFLOW_FLOW_PATH}`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("flow");
    expect(surface.flow).toHaveBeenCalled();
    await s.close();
  });

  test("passes the request body through to the handler", async () => {
    // The queue's payload is the whole message — a dropped body is a run that
    // never advances, with a 200 saying it did.
    let seen: string | undefined;
    const s = await serving(
      surfaceOf({
        flow: async (req) => {
          seen = await req.text();
          return new Response("ok");
        },
      }),
    );
    await fetch(`${s.url}${WORKFLOW_FLOW_PATH}`, { method: "POST", body: `{"runId":"abc"}` });
    expect(seen).toBe(`{"runId":"abc"}`);
    await s.close();
  });

  test("routes a webhook by token, whatever verb the far side used", async () => {
    // The URL went to a third party, which picks its own method.
    const surface = surfaceOf();
    const s = await serving(surface);
    const res = await fetch(`${s.url}${WORKFLOW_WEBHOOK_PREFIX}tok123`);
    expect(res.status).toBe(200);
    expect(surface.webhook).toHaveBeenCalledWith("tok123", expect.any(Request));
    await s.close();
  });

  test("declines flow and step on a non-POST", async () => {
    // They are queue callbacks, not a browsable surface.
    const s = await serving(surfaceOf());
    expect((await fetch(`${s.url}${WORKFLOW_FLOW_PATH}`)).status).toBe(404);
    await s.close();
  });

  test("declines an unrelated path so it falls through to the rest of the server", async () => {
    const s = await serving(surfaceOf());
    expect((await fetch(`${s.url}/health`)).status).toBe(404);
    await s.close();
  });

  test("answers a malformed webhook path instead of killing the process", async () => {
    // The regression for the worst finding of the 2026-08 sweep. `GET
    // /.well-known/workflow/v1/webhook/%` is an unauthenticated request whose raw
    // `%` clears the ""/"/" guards and reached `decodeURIComponent`. Nothing in
    // `webhookToken` → `pickWorkflowHandler` → `handleWorkflowRequest` is async
    // and `createServer` calls them from its `request` hook with no `try`, so the
    // URIError surfaced as an uncaughtException — `process.exit(4)` in the guest,
    // taking every concurrent voice session with it.
    //
    // Driven through a real server (the `serving` harness reproduces exactly that
    // untried synchronous call), so an answer is proof the throw is gone: a
    // handler that threw here would destroy the socket, not answer 404.
    const surface = surfaceOf();
    const s = await serving(surface);
    for (const token of ["%", "%A", "%zz", "%C0%80"]) {
      const res = await fetch(`${s.url}${WORKFLOW_WEBHOOK_PREFIX}${token}`);
      expect(res.status, token).toBe(404);
      expect(await res.text()).toBe("unclaimed");
    }
    // Declined rather than delivered: a token nobody can decode identifies no run.
    expect(surface.webhook).not.toHaveBeenCalled();
    await s.close();
  });

  test("answers 500 when a handler throws, rather than taking the guest down", async () => {
    // These run off a node request event, so an unhandled rejection would kill
    // the process mid-run. A 5xx is also what makes the world retry.
    const errors: unknown[] = [];
    // No `mockRestore()` below: `restoreMocks` in `vitest.shared.ts` restores
    // every `vi.spyOn` before each test, so the call was dead code.
    vi.spyOn(console, "error").mockImplementation((...a) => errors.push(a));
    const s = await serving(
      surfaceOf({
        flow: async () => {
          throw new Error("boom");
        },
      }),
    );
    const res = await fetch(`${s.url}${WORKFLOW_FLOW_PATH}`, { method: "POST" });
    expect(res.status).toBe(500);
    expect(errors.length).toBeGreaterThan(0);
    await s.close();
  });
});

describe("isLoopbackAddress", () => {
  // The whole 127/8 block, not just `127.0.0.1`: `localhost` resolves to
  // `127.0.0.2` and up on some hosts, and refusing those would refuse the
  // guest's OWN queue — a wedge with no error anyone would connect to a gate.
  test.each(["127.0.0.1", "127.0.0.2", "127.255.255.254", "::1", "::ffff:127.0.0.1"])(
    "accepts the loopback peer %s",
    (addr) => {
      expect(isLoopbackAddress(addr)).toBe(true);
    },
  );

  test.each([
    "10.0.0.4",
    "192.168.1.9",
    "172.17.0.2",
    "::ffff:10.0.0.4",
    "2001:db8::1",
    // Not 127/8 despite the prefix — a substring test would take both.
    "127.0.0.1.example.com",
    "1127.0.0.1",
  ])("refuses the off-box peer %s", (addr) => {
    expect(isLoopbackAddress(addr)).toBe(false);
  });

  // FAIL CLOSED. A socket with no peer address is one whose position cannot be
  // established, and the one answer this must never give is "internal, because
  // I could not tell".
  test.each([undefined, ""])("refuses a peer it cannot identify (%s)", (addr) => {
    expect(isLoopbackAddress(addr)).toBe(false);
  });
});

describe("the queue callbacks are guest-internal", () => {
  // Both were reachable UNAUTHENTICATED on every deployed agent's public Modal
  // tunnel, which `GET /:slug/client-config` hands to any browser that asks:
  // `step` executes one of the tenant's registered step functions with the
  // caller's own arguments. See the block comment on `handleWorkflowRequest`.
  test.each([
    ["flow", WORKFLOW_FLOW_PATH],
    ["step", WORKFLOW_STEP_PATH],
  ])("refuses %s from an off-box peer, and does not invoke the handler", async (_l, path) => {
    const external = firstExternalIpv4();
    if (!external) {
      expect.fail("no non-loopback IPv4 interface: cannot produce an off-box peer here");
    }
    const surface = surfaceOf();
    // Bound to every interface, exactly as a deployed guest is.
    const s = await serving(surface, "0.0.0.0");
    try {
      const res = await fetch(`http://${external}:${s.port}${path}`, { method: "POST" });
      expect(res.status).toBe(403);
      // The gate CLAIMED the request — a 404 here would mean it merely fell
      // through, and the next handler to match the path would serve it.
      expect(await res.json()).toEqual({ error: "workflow queue callbacks are guest-internal" });
      expect(surface.flow).not.toHaveBeenCalled();
      expect(surface.step).not.toHaveBeenCalled();
    } finally {
      await s.close();
    }
  });

  test.each([
    ["flow", WORKFLOW_FLOW_PATH],
    ["step", WORKFLOW_STEP_PATH],
  ])("still serves %s to the guest's own queue on loopback", async (_l, path) => {
    const surface = surfaceOf();
    // Same `0.0.0.0` bind as above, so the only difference is the peer.
    const s = await serving(surface, "0.0.0.0");
    try {
      const res = await fetch(`${s.url}${path}`, { method: "POST" });
      expect(res.status).toBe(200);
    } finally {
      await s.close();
    }
  });

  // The webhook URL is handed OUT of the system — to a payment provider, an
  // approval mail — so the platform proxies it and the DevKit's path token is
  // its authorization. Gating it on network position would break every one.
  test("does not gate the webhook route, which is public by design", async () => {
    const external = firstExternalIpv4();
    if (!external) {
      expect.fail("no non-loopback IPv4 interface: cannot produce an off-box peer here");
    }
    const surface = surfaceOf();
    const s = await serving(surface, "0.0.0.0");
    try {
      const res = await fetch(`http://${external}:${s.port}${WORKFLOW_WEBHOOK_PREFIX}tok`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      expect(surface.webhook).toHaveBeenCalledTimes(1);
    } finally {
      await s.close();
    }
  });
});
