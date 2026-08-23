// Copyright 2026 the AAI authors. MIT license.

import { MAX_DB_RESULT_ROWS } from "@alexkroman1/aai/internal";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createPostgresDb } from "./postgres-db.ts";

// Shape-only tests: the `postgres` module is mocked so no connection is ever
// opened — what matters is the options the client is built with and how the
// Db contract maps onto `unsafe`/`end`.
const unsafeMock = vi.fn();
const endMock = vi.fn(() => Promise.resolve());
const postgresMock = vi.fn((..._args: unknown[]) => ({ unsafe: unsafeMock, end: endMock }));

/**
 * The options `createPostgresDb` built its client with.
 *
 * A typed reader rather than `mock.calls[0]?.[1]` re-narrowed per assertion: the
 * mock takes `unknown[]`, so every read of a named option was an error the
 * alternative to which is a cast — and `onnotice` is a FUNCTION three tests
 * invoke, which is exactly where an unchecked read stops being cheap.
 */
function clientOptions(): {
  max?: number;
  prepare?: boolean;
  idle_timeout?: number;
  onnotice?: (n: unknown) => void;
} {
  const [, options] = postgresMock.mock.calls[0] ?? [];
  return (options ?? {}) as ReturnType<typeof clientOptions>;
}

vi.mock("postgres", () => ({ default: (...args: unknown[]) => postgresMock(...args) }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createPostgresDb", () => {
  test("builds the client with the url, a bounded pool, and prepare disabled", () => {
    createPostgresDb({ url: "postgres://db.example/app" });
    // `onnotice` is asserted as PRESENT rather than by identity: postgres.js has
    // no silent default, so leaving it unset is what dumped a whole `42P07`
    // notice object into every guest's stdout on every boot.
    expect(postgresMock).toHaveBeenCalledExactlyOnceWith("postgres://db.example/app", {
      max: 4,
      prepare: false,
      // The one option postgres.js has no useful default for: unset, it keeps
      // every idle connection for the life of the process, and on the platform
      // those are charged against the app role's `connection limit` whether or
      // not anything is using them.
      idle_timeout: expect.any(Number),
      onnotice: expect.any(Function),
    });
    expect(clientOptions().idle_timeout).toBeGreaterThan(0);
  });

  test("a NOTICE prints nothing by default, and does not throw", () => {
    // The fix, stated as the thing an operator sees: postgres.js's own default
    // dumps the whole notice OBJECT, and ours routes it to `consoleLogger.debug`,
    // which is a no-op unless `AAI_DEBUG=1`. So the channel is quiet by default
    // and recoverable on demand — rather than swallowed, which is how the next
    // notice that MATTERS (a truncated identifier, a constraint silently
    // declined) would go unseen.
    const spies = (["debug", "info", "warn", "error", "log"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    createPostgresDb({ url: "postgres://db.example/app" });
    const { onnotice } = clientOptions();
    expect(() =>
      onnotice?.({
        severity: "NOTICE",
        code: "42P07",
        message: 'relation "aai_session_events" already exists, skipping',
        file: "parse_utilcmd.c",
      }),
    ).not.toThrow();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  test("a malformed notice cannot take a session down", () => {
    // It is a callback the DRIVER invokes, so a throw here escapes into the
    // driver's own event handling rather than to any caller.
    createPostgresDb({ url: "postgres://db.example/app" });
    const { onnotice } = clientOptions();
    for (const bad of [undefined, null, "a string", 42]) {
      expect(() => onnotice?.(bad)).not.toThrow();
    }
  });

  test("an explicit onNotice wins, so an embedder can route notices itself", () => {
    const onNotice = vi.fn();
    createPostgresDb({ url: "postgres://db.example/app", onNotice });
    const { onnotice: wired } = clientOptions();
    wired?.({ code: "42P07" });
    expect(onNotice).toHaveBeenCalledOnce();
  });

  test("honors an explicit max", () => {
    createPostgresDb({ url: "postgres://db.example/app", max: 1 });
    expect(clientOptions().max).toBe(1);
  });

  test("honors an explicit idle timeout, zero included", () => {
    // Zero is the meaningful value, not a fallback to the default: postgres.js
    // treats a falsy `idle_timeout` as "never close", which is what a pool whose
    // one connection is reserved for the process's life wants (the workflow lock
    // sweep's presence lock). `?? DEFAULT` would have silently overridden it.
    createPostgresDb({ url: "postgres://db.example/app", idleTimeoutSeconds: 0 });
    expect(clientOptions().idle_timeout).toBe(0);
  });

  test("honors a non-zero idle timeout", () => {
    createPostgresDb({ url: "postgres://db.example/app", idleTimeoutSeconds: 5 });
    expect(clientOptions().idle_timeout).toBe(5);
  });

  test("query runs the statement with its params and resolves the rows", async () => {
    unsafeMock.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    const db = createPostgresDb({ url: "postgres://db.example/app" });
    const rows = await db.query<{ id: number }>("select id from t where id > $1", [0]);
    expect(unsafeMock).toHaveBeenCalledExactlyOnceWith("select id from t where id > $1", [0]);
    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("query defaults params to an empty array", async () => {
    unsafeMock.mockResolvedValueOnce([]);
    const db = createPostgresDb({ url: "postgres://db.example/app" });
    await db.query("select 1");
    expect(unsafeMock).toHaveBeenCalledExactlyOnceWith("select 1", []);
  });

  test("query throws (never truncates) past MAX_DB_RESULT_ROWS", async () => {
    unsafeMock.mockResolvedValueOnce(
      Array.from({ length: MAX_DB_RESULT_ROWS + 1 }, (_, i) => ({ i })),
    );
    const db = createPostgresDb({ url: "postgres://db.example/app" });
    await expect(db.query("select * from big")).rejects.toThrow(
      `query returned more than ${MAX_DB_RESULT_ROWS} rows; add a LIMIT`,
    );
  });

  test("query resolves exactly MAX_DB_RESULT_ROWS rows without throwing", async () => {
    unsafeMock.mockResolvedValueOnce(Array.from({ length: MAX_DB_RESULT_ROWS }, (_, i) => ({ i })));
    const db = createPostgresDb({ url: "postgres://db.example/app" });
    await expect(db.query("select * from big")).resolves.toHaveLength(MAX_DB_RESULT_ROWS);
  });

  test("query rejects when the driver rejects", async () => {
    unsafeMock.mockRejectedValueOnce(new Error("relation does not exist"));
    const db = createPostgresDb({ url: "postgres://db.example/app" });
    await expect(db.query("select * from missing")).rejects.toThrow("relation does not exist");
  });

  test("close ends the pool", async () => {
    const db = createPostgresDb({ url: "postgres://db.example/app" });
    await db.close();
    expect(endMock).toHaveBeenCalledOnce();
  });
});
