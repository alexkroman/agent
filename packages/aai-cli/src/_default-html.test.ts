// Copyright 2025 the AAI authors. MIT license.

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Connect, ViteDevServer } from "vite";
import { describe, expect, test, vi } from "vitest";
import { DEFAULT_HTML, fallbackHtmlPlugin, writeTempHtml } from "./_default-html.ts";
import { withTempDir } from "./_test-utils.ts";

describe("DEFAULT_HTML", () => {
  test("mounts the client entry into #app", () => {
    expect(DEFAULT_HTML).toContain('<main id="app">');
    expect(DEFAULT_HTML).toContain('src="./client.tsx"');
  });
});

describe("writeTempHtml", () => {
  test("writes index.html and cleanup removes it", async () => {
    await withTempDir(async (dir) => {
      const htmlPath = path.join(dir, "index.html");
      const cleanup = writeTempHtml(dir);
      expect(await fs.readFile(htmlPath, "utf-8")).toBe(DEFAULT_HTML);
      cleanup();
      expect(existsSync(htmlPath)).toBe(false);
      // Repeated cleanup is a safe no-op.
      expect(() => cleanup()).not.toThrow();
    });
  });

  test("throws a friendly error when the project directory is unwritable", async () => {
    await withTempDir(async (dir) => {
      // A root that doesn't exist makes writeFileSync fail with ENOENT.
      const missingRoot = path.join(dir, "does-not-exist");
      expect(() => writeTempHtml(missingRoot)).toThrow("is the project directory writable?");
    });
  });

  test("leaves a user-provided index.html untouched", async () => {
    await withTempDir(async (dir) => {
      const htmlPath = path.join(dir, "index.html");
      await fs.writeFile(htmlPath, "<html>user override</html>");
      const cleanup = writeTempHtml(dir);
      expect(await fs.readFile(htmlPath, "utf-8")).toBe("<html>user override</html>");
      cleanup();
      expect(await fs.readFile(htmlPath, "utf-8")).toBe("<html>user override</html>");
    });
  });
});

describe("fallbackHtmlPlugin", () => {
  type FakeRes = { setHeader: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };

  function makeFakeServer() {
    const use = vi.fn();
    const transformIndexHtml = vi.fn(async () => "<html>transformed</html>");
    const server = { middlewares: { use }, transformIndexHtml } as unknown as ViteDevServer;
    return { server, use, transformIndexHtml };
  }

  function getMiddleware(use: ReturnType<typeof vi.fn>): Connect.NextHandleFunction {
    return use.mock.calls[0]?.[0] as Connect.NextHandleFunction;
  }

  /**
   * A response double: `res` for assertions, `res.asServerResponse` for the
   * middleware call. Connect's handler wants a real `ServerResponse`, which
   * the double does not satisfy — that narrowing lives here rather than at
   * each call; the escape-hatch ratchet counts every occurrence.
   */
  function makeRes(onEnd?: () => void): FakeRes & {
    asServerResponse: Parameters<Connect.NextHandleFunction>[1];
  } {
    const res = { setHeader: vi.fn(), end: vi.fn(onEnd) };
    return {
      ...res,
      asServerResponse: res as unknown as Parameters<Connect.NextHandleFunction>[1],
    };
  }

  async function runPlugin(dir: string) {
    const plugin = fallbackHtmlPlugin(dir);
    const fake = makeFakeServer();
    const hook = plugin.configureServer as (server: ViteDevServer) => void;
    hook(fake.server);
    return { plugin, ...fake };
  }

  test("does not install middleware when index.html exists", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "index.html"), "<html>real</html>");
      const { use } = await runPlugin(dir);
      expect(use).not.toHaveBeenCalled();
    });
  });

  test("serves transformed fallback HTML for / and /index.html", async () => {
    await withTempDir(async (dir) => {
      const { use, transformIndexHtml } = await runPlugin(dir);
      const middleware = getMiddleware(use);

      for (const url of ["/", "/index.html"]) {
        const res = makeRes();
        const next = vi.fn();
        middleware({ url } as Connect.IncomingMessage, res.asServerResponse, next);
        await vi.waitFor(() => expect(res.end).toHaveBeenCalledWith("<html>transformed</html>"));
        expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/html");
        expect(next).not.toHaveBeenCalled();
      }
      expect(transformIndexHtml).toHaveBeenCalledWith("/", DEFAULT_HTML, undefined);
    });
  });

  test("passes other URLs through to the next middleware", async () => {
    await withTempDir(async (dir) => {
      const { use } = await runPlugin(dir);
      const middleware = getMiddleware(use);
      const res = makeRes();
      const next = vi.fn();
      middleware({ url: "/assets/app.js" } as Connect.IncomingMessage, res.asServerResponse, next);
      expect(next).toHaveBeenCalled();
      expect(res.end).not.toHaveBeenCalled();
    });
  });

  test("forwards transform errors to next", async () => {
    await withTempDir(async (dir) => {
      const { use, transformIndexHtml } = await runPlugin(dir);
      const error = new Error("transform failed");
      transformIndexHtml.mockRejectedValue(error);
      const middleware = getMiddleware(use);
      const res = makeRes();
      const next = vi.fn();
      middleware({ url: "/" } as Connect.IncomingMessage, res.asServerResponse, next);
      await vi.waitFor(() => expect(next).toHaveBeenCalledWith(error));
      expect(res.end).not.toHaveBeenCalled();
    });
  });

  test("routes a throw in the fulfillment callback to next", async () => {
    await withTempDir(async (dir) => {
      const { use } = await runPlugin(dir);
      const middleware = getMiddleware(use);
      const error = new Error("res.end failed");
      const res = makeRes(() => {
        throw error;
      });
      const next = vi.fn();
      middleware({ url: "/" } as Connect.IncomingMessage, res.asServerResponse, next);
      await vi.waitFor(() => expect(next).toHaveBeenCalledWith(error));
    });
  });
});
