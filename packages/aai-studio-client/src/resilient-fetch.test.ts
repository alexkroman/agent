// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, it, vi } from "vitest";
import { createResilientFetch } from "./resilient-fetch.ts";

function makeFetch(impl: () => Promise<Response>) {
  return vi.fn(impl) as unknown as typeof fetch;
}

describe("createResilientFetch", () => {
  it("passes a successful response through untouched", async () => {
    const onUnauthorized = vi.fn();
    const onStale = vi.fn();
    const body = new Response("ok", { status: 200 });
    const f = createResilientFetch({
      onUnauthorized,
      onStale,
      fetchImpl: makeFetch(() => Promise.resolve(body)),
    });

    await expect(f("http://sandbox.test/studio/chat")).resolves.toBe(body);
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(onStale).not.toHaveBeenCalled();
  });

  it("reports a rejected key on 401", async () => {
    const onUnauthorized = vi.fn();
    const onStale = vi.fn();
    const f = createResilientFetch({
      onUnauthorized,
      onStale,
      fetchImpl: makeFetch(() => Promise.resolve(new Response("", { status: 401 }))),
    });

    await f("http://sandbox.test/studio/chat");

    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(onStale).not.toHaveBeenCalled();
  });

  it("re-brokers on 409 (the sandbox was replaced under us)", async () => {
    const onStale = vi.fn();
    const f = createResilientFetch({
      onUnauthorized: vi.fn(),
      onStale,
      fetchImpl: makeFetch(() => Promise.resolve(new Response("", { status: 409 }))),
    });

    await f("http://sandbox.test/studio/chat");

    expect(onStale).toHaveBeenCalledOnce();
  });

  // The gap this module closes: a killed sandbox makes fetch REJECT, so a
  // wrapper that only inspects res.status never runs and the tab wedges on
  // "Failed to fetch" until a manual reload.
  it("re-brokers when the sandbox is unreachable, and rethrows", async () => {
    const onStale = vi.fn();
    const boom = new TypeError("Failed to fetch");
    const f = createResilientFetch({
      onUnauthorized: vi.fn(),
      onStale,
      fetchImpl: makeFetch(() => Promise.reject(boom)),
    });

    await expect(f("http://sandbox.test/studio/chat")).rejects.toBe(boom);
    expect(onStale).toHaveBeenCalledOnce();
  });

  it("does NOT re-broker when the user pressed Stop", async () => {
    const onStale = vi.fn();
    const abort = new DOMException("The operation was aborted.", "AbortError");
    const f = createResilientFetch({
      onUnauthorized: vi.fn(),
      onStale,
      fetchImpl: makeFetch(() => Promise.reject(abort)),
    });

    await expect(f("http://sandbox.test/studio/chat")).rejects.toBe(abort);
    expect(onStale).not.toHaveBeenCalled();
  });

  it("does NOT re-broker when the caller's signal is already aborted", async () => {
    const onStale = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const f = createResilientFetch({
      onUnauthorized: vi.fn(),
      onStale,
      fetchImpl: makeFetch(() => Promise.reject(new TypeError("Failed to fetch"))),
    });

    await expect(
      f("http://sandbox.test/studio/chat", { signal: controller.signal }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(onStale).not.toHaveBeenCalled();
  });
});
