// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { createSingleFlight, keyedMemoAsync, memoAsync } from "./_memo.ts";

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

  test("a rejection settling after clear() does not evict the successor", async () => {
    // The build's reset is by ownership: `clear()` frees the key while the
    // first build is still in flight, the next call claims it, and the first
    // one's rejection must not take that claim down with it.
    const memo = keyedMemoAsync<string>();
    const { promise, reject } = Promise.withResolvers<string>();

    const failing = memo("k", () => promise);
    memo.clear();
    await expect(memo("k", () => Promise.resolve("successor"))).resolves.toBe("successor");

    reject(new Error("boom"));
    await expect(failing).rejects.toThrow("boom");

    // Still memoized: the successor's entry survived the late rejection.
    const rebuilt = vi.fn(async () => "rebuilt");
    await expect(memo("k", rebuilt)).resolves.toBe("successor");
    expect(rebuilt).not.toHaveBeenCalled();
  });
});

describe("createSingleFlight", () => {
  /** A load whose settlement the test controls. */
  function gate<T>() {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    return { load: () => promise, resolve, reject };
  }

  test("concurrent callers share ONE load and all see its value", async () => {
    const flight = createSingleFlight<string>();
    const { load, resolve } = gate<string>();
    const loader = vi.fn(load);

    const calls = [flight.run("k", loader), flight.run("k", loader), flight.run("k", loader)];
    resolve("value");

    await expect(Promise.all(calls)).resolves.toEqual(["value", "value", "value"]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  test("nothing is retained: a caller after settlement loads again", async () => {
    const flight = createSingleFlight<string>();
    const loader = vi.fn(async () => "value");

    await flight.run("k", loader);
    await flight.run("k", loader);

    expect(loader).toHaveBeenCalledTimes(2);
    expect(flight.size()).toBe(0);
  });

  test("keys are independent", async () => {
    const flight = createSingleFlight<string>();
    const { load: loadA, resolve: resolveA } = gate<string>();
    const { load: loadB, resolve: resolveB } = gate<string>();

    const a = flight.run("a", loadA);
    const b = flight.run("b", loadB);
    expect(flight.size()).toBe(2);
    resolveA("a-value");
    resolveB("b-value");

    await expect(a).resolves.toBe("a-value");
    await expect(b).resolves.toBe("b-value");
  });

  test("a rejection reaches every joiner and leaves nothing behind", async () => {
    const flight = createSingleFlight<string>();
    const { load, reject } = gate<string>();

    const first = flight.run("k", load);
    const joiner = flight.run("k", load);
    reject(new Error("boom"));

    await expect(first).rejects.toThrow("boom");
    await expect(joiner).rejects.toThrow("boom");
    expect(flight.size()).toBe(0);
    await expect(flight.run("k", () => Promise.resolve("retried"))).resolves.toBe("retried");
  });

  test("drop() makes the NEXT caller start a fresh load", async () => {
    const flight = createSingleFlight<string>();
    const { load, resolve } = gate<string>();

    const before = flight.run("k", load);
    flight.drop("k");
    const after = flight.run("k", () => Promise.resolve("fresh"));
    resolve("stale");

    await expect(before).resolves.toBe("stale");
    await expect(after).resolves.toBe("fresh");
  });

  test("a dropped load settling later cannot evict its successor", async () => {
    const flight = createSingleFlight<string>();
    const dropped = gate<string>();
    const successor = gate<string>();

    const first = flight.run("k", dropped.load);
    flight.drop("k");
    const second = flight.run("k", successor.load);
    // The dropped load settles AFTER the successor claimed the key.
    dropped.resolve("stale");
    await expect(first).resolves.toBe("stale");

    // The successor is still joinable — its entry survived the other's release.
    const joiner = flight.run("k", () => Promise.reject(new Error("must not load")));
    successor.resolve("fresh");
    await expect(second).resolves.toBe("fresh");
    await expect(joiner).resolves.toBe("fresh");
  });
});
