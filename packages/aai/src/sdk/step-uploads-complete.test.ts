// Copyright 2026 the AAI authors. MIT license.
import { afterEach, describe, expect, test } from "vitest";
import { publishUploadReader, type UploadAccess } from "./step-uploads.ts";
import { stepRequireCompleteUpload } from "./step-uploads-complete.ts";

/** Publish a reader over one in-memory file, recording the windows it is asked for. */
function publish(bytes: Uint8Array, over: Partial<UploadAccess> = {}) {
  const reads: { start: number; end: number }[] = [];
  publishUploadReader({
    info: async (id) =>
      id === "upl_1"
        ? { id, name: "a.wav", type: "audio/wav", size: bytes.length, complete: true }
        : undefined,
    read: async (_id, start, end) => {
      reads.push({ start, end });
      return bytes.subarray(start, end);
    },
    ...over,
  });
  return reads;
}

// A slot left published would make the next file's steps read this one's bytes.
afterEach(() => publishUploadReader(undefined));

describe("stepRequireCompleteUpload", () => {
  test("answers with the record when every byte is in", async () => {
    publish(new Uint8Array([1, 2, 3]));
    expect(await stepRequireCompleteUpload("upl_1")).toMatchObject({ size: 3, complete: true });
  });

  test("refuses one that is still arriving, and names the fix", async () => {
    publish(new Uint8Array([1, 2, 3]), {
      info: async (id) => ({ id, name: "", type: "", size: 3, complete: false }),
    });

    // The sentence is the whole product here: the reader is a step author whose
    // run started a moment too early, and the two supported orders — wait for the
    // upload, or poll it from the body — are what the message has to name.
    await expect(stepRequireCompleteUpload("upl_1")).rejects.toMatchObject({
      name: "UploadIncompleteError",
      // NOT retryable: `toStepError` reads this structurally, so a step ending
      // `.catch(throwStepError)` fails the run rather than spending the budget of
      // the most expensive step in the flow on an upload that will not be there.
      retryable: false,
      // The PREFIX at the moment of the check, which is the number a reader needs
      // to tell "nothing has arrived" from "we were one window short".
      stored: 3,
    });
    await expect(stepRequireCompleteUpload("upl_1")).rejects.toThrow(/ctx\.sleep/);
  });

  test("reports an id that names nothing exactly as stepUploadInfo does", async () => {
    publish(new Uint8Array([1]));
    await expect(stepRequireCompleteUpload("nope")).rejects.toThrow(/No upload with id nope/);
  });
});
