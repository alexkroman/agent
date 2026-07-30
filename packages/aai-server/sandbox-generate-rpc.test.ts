// Copyright 2026 the AAI authors. MIT license.
/**
 * The guest's `ctx.generate` surface: the llm/generate RPC handler that
 * `registerGuestRpcHandlers` wires when a host generate fn is supplied, and
 * `createSandbox` handing that fn to the VM options. Generation is a host
 * capability like KV — the guest has no network — so if either half is
 * dropped, deployed tool code calling `ctx.generate` fails with a bare
 * "Method not found" while `aai dev` works: exactly the parity drift the
 * one-implementation rule exists to prevent.
 */

import type { HostGenerateFn } from "@alexkroman1/aai/runtime";
import { describe, expect, it, vi } from "vitest";
import type { NdjsonConnection } from "./ndjson-transport.ts";
import { registerGuestRpcHandlers } from "./sandbox-guest-rpc.ts";

type Handler = (params: unknown) => Promise<unknown>;

function fakeConn(): { conn: NdjsonConnection; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const conn = {
    sendRequest: vi.fn(),
    sendNotification: vi.fn(),
    onRequest: vi.fn((method: string, handler: Handler) => {
      handlers.set(method, handler);
    }),
    onNotification: vi.fn(),
    listen: vi.fn(),
    dispose: vi.fn(),
  } as unknown as NdjsonConnection;
  return { conn, handlers };
}

describe("registerGuestRpcHandlers — llm/generate", () => {
  it("registers the handler only when a generate fn is supplied", () => {
    const withGenerate = fakeConn();
    registerGuestRpcHandlers(withGenerate.conn, { generate: vi.fn() });
    expect(withGenerate.handlers.has("llm/generate")).toBe(true);

    const without = fakeConn();
    registerGuestRpcHandlers(without.conn, {});
    expect(without.handlers.has("llm/generate")).toBe(false);
  });

  it("forwards validated params and returns the generate result", async () => {
    const { conn, handlers } = fakeConn();
    const generate: HostGenerateFn = vi
      .fn()
      .mockResolvedValue({ text: '{"ok":true}', object: { ok: true } });
    registerGuestRpcHandlers(conn, { generate });

    const handler = handlers.get("llm/generate");
    const result = await handler?.({
      prompt: "classify this",
      system: "be terse",
      llm: { kind: "anthropic", options: { model: "m" } },
      schema: { type: "object" },
      temperature: 0,
      maxOutputTokens: 128,
    });

    expect(result).toEqual({ text: '{"ok":true}', object: { ok: true } });
    expect(generate).toHaveBeenCalledWith({
      prompt: "classify this",
      system: "be terse",
      llm: { kind: "anthropic", options: { model: "m" } },
      schema: { type: "object" },
      temperature: 0,
      maxOutputTokens: 128,
    });
  });

  it("omits absent optional params instead of passing undefined", async () => {
    const { conn, handlers } = fakeConn();
    const generate: HostGenerateFn = vi.fn().mockResolvedValue({ text: "hi" });
    registerGuestRpcHandlers(conn, { generate });

    await handlers.get("llm/generate")?.({ prompt: "p" });
    expect(generate).toHaveBeenCalledWith({ prompt: "p" });
  });

  it("rejects malformed params before they reach the generate fn", async () => {
    const { conn, handlers } = fakeConn();
    const generate: HostGenerateFn = vi.fn();
    registerGuestRpcHandlers(conn, { generate });
    const handler = handlers.get("llm/generate");

    await expect(handler?.({ prompt: "" })).rejects.toThrow();
    await expect(handler?.({})).rejects.toThrow();
    await expect(handler?.({ prompt: "p", llm: { kind: "" } })).rejects.toThrow();
    await expect(handler?.({ prompt: "p", maxOutputTokens: -1 })).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
  });
});
