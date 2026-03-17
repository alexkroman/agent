import { describe, expect, test, vi } from "vitest";
import { withTimeout } from "./_timeout.ts";

describe("withTimeout", () => {
  test("returns resolved value when promise settles before timeout", async () => {
    const result = await withTimeout(Promise.resolve("hello"), 1000);
    expect(result).toBe("hello");
  });

  test("rejects when promise exceeds timeout", async () => {
    vi.useFakeTimers();
    const neverResolve = new Promise(() => {});
    const promise = withTimeout(neverResolve, 100);
    vi.advanceTimersByTime(100);
    await expect(promise).rejects.toThrow("RPC timed out after 100ms");
    vi.useRealTimers();
  });

  test("returns original promise when timeoutMs is undefined", async () => {
    const result = await withTimeout(Promise.resolve("value"), undefined);
    expect(result).toBe("value");
  });

  test("returns original promise when timeoutMs is 0", async () => {
    const result = await withTimeout(Promise.resolve("value"), 0);
    expect(result).toBe("value");
  });

  test("normalizes capnweb RpcPromise proxies", async () => {
    // p-timeout handles proxy normalization via Promise.resolve wrapping
    const proxyLike = {
      // biome-ignore lint/suspicious/noThenProperty: intentionally mimics a thenable
      then: (fn: (v: string) => void) => fn("proxied"),
    } as unknown as Promise<string>;
    const result = await withTimeout(proxyLike, 1000);
    expect(result).toBe("proxied");
  });
});
