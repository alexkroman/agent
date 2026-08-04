// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { keyedMemoAsync, memoAsync } from "./_memo.ts";

describe("memoAsync", () => {
  test("builds once and memoizes the result", async () => {
    const build = vi.fn(async () => "value");
    const memoized = memoAsync(build);
    await expect(memoized()).resolves.toBe("value");
    await expect(memoized()).resolves.toBe("value");
    expect(build).toHaveBeenCalledTimes(1);
  });

  test("a rejection clears the memo so the next call retries", async () => {
    const build = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("recovered");
    const memoized = memoAsync(build);
    await expect(memoized()).rejects.toThrow("transient");
    await expect(memoized()).resolves.toBe("recovered");
    expect(build).toHaveBeenCalledTimes(2);
  });

  test("reset() drops a successful memo", async () => {
    const build = vi.fn(async () => "value");
    const memoized = memoAsync(build);
    await memoized();
    memoized.reset();
    await memoized();
    expect(build).toHaveBeenCalledTimes(2);
  });
});

describe("keyedMemoAsync", () => {
  test("memoizes per key", async () => {
    const memo = keyedMemoAsync<string>();
    const build = vi.fn(async (v: string) => v);
    await expect(memo("a", () => build("a"))).resolves.toBe("a");
    await expect(memo("a", () => build("a"))).resolves.toBe("a");
    await expect(memo("b", () => build("b"))).resolves.toBe("b");
    expect(build).toHaveBeenCalledTimes(2);
  });

  test("a rejection clears only that key", async () => {
    const memo = keyedMemoAsync<string>();
    await expect(memo("bad", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(memo("good", () => Promise.resolve("ok"))).resolves.toBe("ok");
    // The failed key retries; the good key stays memoized.
    await expect(memo("bad", () => Promise.resolve("retried"))).resolves.toBe("retried");
    const rebuilt = vi.fn(async () => "never");
    await expect(memo("good", rebuilt)).resolves.toBe("ok");
    expect(rebuilt).not.toHaveBeenCalled();
  });

  test("clear() drops every key", async () => {
    const memo = keyedMemoAsync<string>();
    await memo("a", () => Promise.resolve("first"));
    memo.clear();
    await expect(memo("a", () => Promise.resolve("second"))).resolves.toBe("second");
  });
});
