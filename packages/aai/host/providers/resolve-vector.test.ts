// Copyright 2025 the AAI authors. MIT license.
import { afterEach, describe, expect, it } from "vitest";
import { inMemoryVector } from "../../sdk/providers/vector/in-memory.ts";
import { pinecone } from "../../sdk/providers/vector/pinecone.ts";
import { _resetMemoryVectorForTests } from "../memory-vector.ts";
import { resolveVector } from "./resolve-vector.ts";

afterEach(() => _resetMemoryVectorForTests());

describe("resolveVector", () => {
  it("resolves inMemoryVector descriptor to a working store", async () => {
    const v = resolveVector(inMemoryVector(), {}, "ns1");
    await v.upsert("doc", "hello");
    expect((await v.query("hello"))[0]?.id).toBe("doc");
  });

  it("throws clear error when PINECONE_API_KEY is missing", () => {
    expect(() => resolveVector(pinecone({ index: "ix" }), {}, "ns")).toThrow(/PINECONE_API_KEY/);
  });

  it("throws on unknown kind", () => {
    expect(() => resolveVector({ kind: "nope", options: {} }, {}, "ns")).toThrow(
      /Unknown Vector provider/,
    );
  });
});
