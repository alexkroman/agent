// Copyright 2025 the AAI authors. MIT license.
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { QuickTunnel } from "./_dev-tunnel.ts";
import { createFakeUi, stubProcessExit } from "./_test-utils.ts";
import { type DevDeps, executeDev } from "./dev.ts";

const mockCleanup = vi.fn();
const mockStartDevServer = vi.fn(async () => mockCleanup);
/** The fake terminal's `notify` — the channel `aai dev` reports through. */
const mockNotify = vi.fn();

/** What every spec hands `executeDev`: a fake dev server and a fake terminal. */
function baseDeps(): DevDeps {
  return {
    startDevServer: mockStartDevServer,
    ui: { ...createFakeUi(), notify: mockNotify },
  };
}

// `mockCleanup`, `mockStartDevServer` and `mockNotify` are module-level
// `vi.fn()`s. `restoreMocks: true` registers only `vi.spyOn` mocks, so it
// clears none of their call history — without this, the
// `toHaveBeenCalledTimes(1)` assertions below count every call since the file
// started rather than the ones this test made.
beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Run executeDev with process.on intercepted, so signal/error handlers are
 * captured instead of registered on the real test process (an actual
 * uncaughtException handler would swallow other tests' failures).
 */
async function withCapturedHandlers(
  fn: (handlers: Map<string, (...args: unknown[]) => void>) => Promise<void>,
): Promise<void> {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const onSpy = vi.spyOn(process, "on").mockImplementation(((
    event: string,
    handler: (...args: unknown[]) => void,
  ) => {
    handlers.set(event, handler);
    return process;
  }) as typeof process.on);
  const exitSpy = stubProcessExit();
  try {
    await fn(handlers);
  } finally {
    onSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

describe("executeDev", () => {
  test("starts the dev server and returns the url", async () => {
    await withCapturedHandlers(async () => {
      mockCleanup.mockResolvedValue(undefined);
      const result = await executeDev({ cwd: "/tmp/agent", port: "3123" }, baseDeps());
      expect(mockStartDevServer).toHaveBeenCalledWith(
        { cwd: "/tmp/agent", port: 3123 },
        expect.objectContaining({ ui: expect.anything() }),
      );
      expect(result).toEqual({ ok: true, data: { url: "http://localhost:3123" } });
    });
  });

  // SIGINT followed by SIGTERM (common under process supervisors) must not run
  // cleanup twice concurrently — double server close is ERR_SERVER_NOT_RUNNING
  // noise and a double runtime shutdown.
  test("second signal joins the in-flight cleanup instead of re-running it", async () => {
    await withCapturedHandlers(async (handlers) => {
      const inFlight = Promise.withResolvers<void>();
      mockCleanup.mockReturnValue(inFlight.promise);

      await executeDev({ cwd: "/tmp/agent", port: "3123" }, baseDeps());
      const sigint = handlers.get("SIGINT");
      const sigterm = handlers.get("SIGTERM");
      expect(sigint).toBeDefined();
      expect(sigterm).toBeDefined();

      sigint?.();
      sigterm?.();
      sigint?.();
      expect(mockCleanup).toHaveBeenCalledTimes(1);

      inFlight.resolve();
      await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
      expect(process.exit).toHaveBeenCalledTimes(1);
    });
  });

  // The defense-in-depth process handlers must report and keep the host alive —
  // one bad session's stray rejection/throw must not crash every other one.
  //
  // They report through `notify`, not `log`: `aai dev` is long-running and JSON
  // mode (auto-detected on a pipe) no-ops every `log` method for the rest of the
  // process, so a piped dev server hid these entirely. Asserting on `notify`
  // is what keeps a revert to `log.error` from silently going unnoticed again.
  test("unhandledRejection and uncaughtException handlers report without exiting", async () => {
    await withCapturedHandlers(async (handlers) => {
      mockCleanup.mockResolvedValue(undefined);
      await executeDev({ cwd: "/tmp/agent", port: "3123" }, baseDeps());
      mockNotify.mockClear();

      handlers.get("unhandledRejection")?.(new Error("socket died"));
      expect(mockNotify).toHaveBeenCalledWith("error", expect.stringContaining("socket died"));

      handlers.get("uncaughtException")?.(new Error("callback threw"));
      expect(mockNotify).toHaveBeenCalledWith("error", expect.stringContaining("callback threw"));

      expect(process.exit).not.toHaveBeenCalled();
    });
  });
});

const TUNNEL_URL = "https://quiet-river-1a2b.trycloudflare.com";

/**
 * Fake tunnel + hook runners, recording the order of every teardown step in
 * `events` so a spec can pin the shutdown sequence.
 */
function fakeTunnelDeps({
  hookCode = 0,
  hookThrows = false,
}: {
  hookCode?: number | null;
  hookThrows?: boolean;
} = {}) {
  const events: string[] = [];
  const exited = Promise.withResolvers<number | null>();
  const tunnel: QuickTunnel = {
    url: TUNNEL_URL,
    exited: exited.promise,
    close: vi.fn(async () => {
      events.push("tunnel.close");
    }),
  };
  const startQuickTunnel = vi.fn(async () => tunnel);
  const runPublicUrlHook = vi.fn(
    async (command: string, url: string, _o: { cwd: string; timeoutMs?: number | undefined }) => {
      events.push(`hook:${command}:${url}`);
      if (hookThrows) throw new Error("sh: not found");
      return hookCode;
    },
  );
  const deps: DevDeps = { ...baseDeps(), startQuickTunnel, runPublicUrlHook };
  return { deps, tunnel, exited, events, startQuickTunnel, runPublicUrlHook };
}

describe("executeDev --tunnel / --on-public-url", () => {
  beforeEach(() => {
    // Stubbed so the direct `process.env.PUBLIC_URL = …` in dev.ts is undone
    // by `unstubEnvs` after each spec.
    vi.stubEnv("PUBLIC_URL", "");
    vi.stubEnv("AAI_DEV_HOST", "");
  });

  test("--on-public-url with no tunnel and no PUBLIC_URL is a usage error", async () => {
    await withCapturedHandlers(async () => {
      await expect(
        executeDev({ cwd: "/tmp/agent", port: "3123", onPublicUrl: "./publish.sh" }, baseDeps()),
      ).rejects.toMatchObject({ code: "usage" });
      expect(mockStartDevServer).not.toHaveBeenCalled();
    });
  });

  test("the tunnel URL becomes PUBLIC_URL, is returned, and the hook runs with it", async () => {
    await withCapturedHandlers(async () => {
      mockCleanup.mockResolvedValue(undefined);
      const f = fakeTunnelDeps();
      const result = await executeDev(
        { cwd: "/tmp/agent", port: "3123", tunnel: true, onPublicUrl: " ./publish.sh " },
        f.deps,
      );
      expect(f.startQuickTunnel).toHaveBeenCalledWith({ origin: "http://127.0.0.1:3123" });
      expect(process.env.PUBLIC_URL).toBe(TUNNEL_URL);
      expect(result).toEqual({
        ok: true,
        data: { url: "http://localhost:3123", publicUrl: TUNNEL_URL },
      });
      expect(f.events).toEqual([`hook:./publish.sh:${TUNNEL_URL}`]);
      expect(mockNotify).toHaveBeenCalledWith("info", `Public URL: ${TUNNEL_URL}`);
    });
  });

  test("the tunnel dials the interface AAI_DEV_HOST binds, loopback for a wildcard", async () => {
    await withCapturedHandlers(async () => {
      mockCleanup.mockResolvedValue(undefined);
      vi.stubEnv("AAI_DEV_HOST", "192.168.1.20");
      const bound = fakeTunnelDeps();
      await executeDev({ cwd: "/tmp/agent", port: "3123", tunnel: true }, bound.deps);
      expect(bound.startQuickTunnel).toHaveBeenCalledWith({ origin: "http://192.168.1.20:3123" });

      vi.stubEnv("AAI_DEV_HOST", "0.0.0.0");
      const wildcard = fakeTunnelDeps();
      await executeDev({ cwd: "/tmp/agent", port: "3123", tunnel: true }, wildcard.deps);
      expect(wildcard.startQuickTunnel).toHaveBeenCalledWith({ origin: "http://127.0.0.1:3123" });
    });
  });

  test("a signal withdraws the URL, closes the tunnel, then stops the server", async () => {
    await withCapturedHandlers(async (handlers) => {
      const f = fakeTunnelDeps();
      mockCleanup.mockImplementation(async () => {
        f.events.push("server.close");
      });
      await executeDev(
        { cwd: "/tmp/agent", port: "3123", tunnel: true, onPublicUrl: "./publish.sh" },
        f.deps,
      );
      handlers.get("SIGINT")?.();
      await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
      expect(f.events).toEqual([
        `hook:./publish.sh:${TUNNEL_URL}`,
        "hook:./publish.sh:",
        "tunnel.close",
        "server.close",
      ]);
      expect(f.runPublicUrlHook).toHaveBeenLastCalledWith("./publish.sh", "", {
        cwd: "/tmp/agent",
        timeoutMs: 10_000,
      });
    });
  });

  test("cloudflared exiting on its own ends aai dev with exit 1", async () => {
    await withCapturedHandlers(async () => {
      mockCleanup.mockResolvedValue(undefined);
      const f = fakeTunnelDeps();
      await executeDev({ cwd: "/tmp/agent", port: "3123", tunnel: true }, f.deps);
      f.exited.resolve(1);
      await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
      expect(mockNotify).toHaveBeenCalledWith(
        "error",
        expect.stringContaining("cloudflared exited"),
      );
    });
  });

  test("a dev server that fails to start closes the tunnel and rethrows", async () => {
    await withCapturedHandlers(async () => {
      const f = fakeTunnelDeps();
      mockStartDevServer.mockRejectedValueOnce(new Error("bundle failed"));
      await expect(
        executeDev({ cwd: "/tmp/agent", port: "3123", tunnel: true }, f.deps),
      ).rejects.toThrow("bundle failed");
      expect(f.tunnel.close).toHaveBeenCalledTimes(1);
    });
  });

  test("a signal mid-startup closes the tunnel before exiting 130", async () => {
    await withCapturedHandlers(async (handlers) => {
      const f = fakeTunnelDeps();
      const pending = Promise.withResolvers<typeof mockCleanup>();
      mockStartDevServer.mockReturnValueOnce(pending.promise);
      const run = executeDev({ cwd: "/tmp/agent", port: "3123", tunnel: true }, f.deps);
      await vi.waitFor(() => expect(mockStartDevServer).toHaveBeenCalled());
      handlers.get("SIGTERM")?.();
      await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(130));
      expect(f.tunnel.close).toHaveBeenCalled();
      pending.resolve(mockCleanup);
      await run;
    });
  });

  test("an exported PUBLIC_URL runs the hook without a tunnel; --tunnel replaces it, warning", async () => {
    await withCapturedHandlers(async () => {
      mockCleanup.mockResolvedValue(undefined);
      vi.stubEnv("PUBLIC_URL", "https://agent.example.com");
      const plain = fakeTunnelDeps();
      const result = await executeDev(
        { cwd: "/tmp/agent", port: "3123", onPublicUrl: "./publish.sh" },
        plain.deps,
      );
      expect(plain.startQuickTunnel).not.toHaveBeenCalled();
      expect(result).toMatchObject({ data: { publicUrl: "https://agent.example.com" } });
      expect(plain.events).toEqual(["hook:./publish.sh:https://agent.example.com"]);

      const tunnelled = fakeTunnelDeps();
      await executeDev({ cwd: "/tmp/agent", port: "3123", tunnel: true }, tunnelled.deps);
      expect(mockNotify).toHaveBeenCalledWith(
        "warn",
        expect.stringContaining("replaces PUBLIC_URL=https://agent.example.com"),
      );
    });
  });

  test("a failing or unrunnable hook is reported, not fatal", async () => {
    await withCapturedHandlers(async () => {
      mockCleanup.mockResolvedValue(undefined);
      const nonzero = fakeTunnelDeps({ hookCode: 2 });
      const ok = await executeDev(
        { cwd: "/tmp/agent", port: "3123", tunnel: true, onPublicUrl: "./publish.sh" },
        nonzero.deps,
      );
      expect(ok.ok).toBe(true);
      expect(mockNotify).toHaveBeenCalledWith(
        "warn",
        "--on-public-url exited 2 with the public URL.",
      );

      const throws = fakeTunnelDeps({ hookThrows: true });
      await executeDev(
        { cwd: "/tmp/agent", port: "3123", tunnel: true, onPublicUrl: "./publish.sh" },
        throws.deps,
      );
      expect(mockNotify).toHaveBeenCalledWith(
        "warn",
        expect.stringMatching(/could not run with the public URL: .*sh: not found/s),
      );
      expect(process.exit).not.toHaveBeenCalled();
    });
  });
});
