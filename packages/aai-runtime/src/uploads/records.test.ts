// Copyright 2026 the AAI authors. MIT license.
// The Postgres upload-record home: the statements it issues, and how it
// normalizes what the driver answers into an `UploadRecord`. Its DDL pass is
// pinned through the store in `store-blobs.test.ts`.

import { describe, expect, test } from "vitest";
import { recordingDb } from "../_db-test-utils.ts";
import { createPostgresUploadRecords } from "./records.ts";
import { UploadIdTakenError } from "./store.ts";

const RECORD = { name: "a.wav", type: "audio/wav", size: 0, complete: false, parts: [] };

describe("createPostgresUploadRecords", () => {
  test("read normalizes the driver's strings, NULL total and jsonb parts", async () => {
    const db = recordingDb([
      [
        {
          name: "a.wav",
          type: "audio/wav",
          size: "4",
          complete: true,
          expected: "8",
          parts: '[{"at":0,"bytes":4},{"at":-1,"bytes":2}]',
        },
      ],
      [{ name: "b", type: "", size: "3", complete: true, expected: null, parts: null }],
    ]);
    const records = createPostgresUploadRecords(db);
    await expect(records.read("upl_1")).resolves.toEqual({
      name: "a.wav",
      type: "audio/wav",
      size: 4,
      complete: true,
      expected: 8,
      parts: [{ at: 0, bytes: 4 }],
    });
    const streamed = await records.read("upl_2");
    expect(streamed).not.toHaveProperty("expected");
    expect(streamed?.parts).toEqual([]);
    expect(db.issued[0]?.params).toEqual(["upl_1"]);
  });

  test("read answers undefined for an id nothing began", async () => {
    await expect(createPostgresUploadRecords(recordingDb()).read("upl_x")).resolves.toBeUndefined();
  });

  test("claim refuses an id already held, even by an identical declaration", async () => {
    const db = recordingDb([[{ id: "upl_1" }], []]);
    const records = createPostgresUploadRecords(db);
    await records.claim("upl_1", { ...RECORD, expected: 8 });
    await expect(records.claim("upl_1", { ...RECORD, expected: 8 })).rejects.toThrow(
      UploadIdTakenError,
    );
    expect(db.issued[0]?.params).toEqual(["upl_1", "a.wav", "audio/wav", false, 8]);
  });

  test("insert, update and finish bind the record's fields, parts as JSON text", async () => {
    const db = recordingDb();
    const records = createPostgresUploadRecords(db);
    const parts = [{ at: 0, bytes: 4 }];
    await records.insert("upl_1", { ...RECORD, size: 4, parts });
    await records.update("upl_1", { size: 4, complete: true, parts });
    await records.finish("upl_1", 9);
    expect(db.issued.map((s) => s.params)).toEqual([
      ["upl_1", "a.wav", "audio/wav", 4, JSON.stringify(parts)],
      ["upl_1", JSON.stringify(parts), 4, true],
      ["upl_1", 9],
    ]);
    expect(db.sql[0]).toContain("$5::text::jsonb");
  });
});
