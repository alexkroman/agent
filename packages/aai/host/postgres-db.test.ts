// Copyright 2026 the AAI authors. MIT license.

import { beforeEach, describe, expect, test, vi } from "vitest";
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
