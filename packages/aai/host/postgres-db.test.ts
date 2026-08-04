// Copyright 2026 the AAI authors. MIT license.

import { beforeEach, describe, expect, test, vi } from "vitest";
import { MAX_DB_RESULT_ROWS } from "../sdk/db.ts";
import { createPostgresDb } from "./postgres-db.ts";

// Shape-only tests: the `postgres` module is mocked so no connection is ever
// opened — what matters is the options the client is built with and how the
// Db contract maps onto `unsafe`/`end`.
const unsafeMock = vi.fn();
const endMock = vi.fn(() => Promise.resolve());
const postgresMock = vi.fn((..._args: unknown[]) => ({ unsafe: unsafeMock, end: endMock }));

vi.mock("postgres", () => ({ default: (...args: unknown[]) => postgresMock(...args) }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createPostgresDb", () => {
  test("builds the client with the url, a bounded pool, and prepare disabled", () => {
    createPostgresDb({ url: "postgres://db.example/app" });
    expect(postgresMock).toHaveBeenCalledExactlyOnceWith("postgres://db.example/app", {
      max: 4,
      prepare: false,
    });
  });

  test("honors an explicit max", () => {
    createPostgresDb({ url: "postgres://db.example/app", max: 1 });
    expect(postgresMock).toHaveBeenCalledExactlyOnceWith("postgres://db.example/app", {
      max: 1,
      prepare: false,
    });
  });

  test("leaves notices to the driver's default handler by default", () => {
    // A tenant's `raise notice` is their own debugging output — `ctx.db` must
    // not swallow it.
    createPostgresDb({ url: "postgres://db.example/app" });
    expect(postgresMock.mock.calls[0]?.[1]).not.toHaveProperty("onnotice");
  });

  test("quietDdlNotices drops already-exists notices and keeps the rest", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    createPostgresDb({ url: "postgres://db.example/app", quietDdlNotices: true });
    const [, options] = postgresMock.mock.calls[0] ?? [];
    const { onnotice } = options as { onnotice: (n: unknown) => void };

    // The two raised by re-running `create schema/table if not exists`.
    onnotice({ code: "42P06", message: 'schema "aai_platform" already exists, skipping' });
    onnotice({ code: "42P07", message: 'relation "agents" already exists, skipping' });
    expect(info).not.toHaveBeenCalled();

    // Anything else still surfaces — as one line, not a multi-line dump.
    onnotice({ code: "22P02", message: "something worth seeing" });
    expect(info).toHaveBeenCalledExactlyOnceWith("postgres notice [22P02] something worth seeing");
    info.mockRestore();
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
