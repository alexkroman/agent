// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
//
// Where an upload id survives a reload. The property: a file re-picked after a
// refresh recalls the id the previous load was storing it under, so the walk can
// resume it instead of sending the file again.

import { afterEach, describe, expect, test, vi } from "vitest";
import { forgetUploadId, recallUploadId, rememberUploadId } from "./_upload-recall.ts";

/** A file with a FIXED identity, so a second object can be the same file. */
function pick(name: string, bytes = "abc", lastModified = 1_700_000_000_000): File {
  return new File([bytes], name, { type: "audio/wav", lastModified });
}

afterEach(() => {
  sessionStorage.clear();
});

describe("_upload-recall", () => {
  test("round-trips an id, and forgets it on demand", () => {
    const file = pick("standup.wav");
    expect(recallUploadId("digest", file)).toBeUndefined();
    rememberUploadId("digest", file, "upl_1");
    expect(recallUploadId("digest", file)).toBe("upl_1");
    forgetUploadId("digest", file);
    expect(recallUploadId("digest", file)).toBeUndefined();
  });

  test("recalls across File OBJECTS, which is the whole reload case", () => {
    // A reload empties the input, so the person picks the file again and the
    // browser hands over a brand-new `File`. Nothing about the object survives —
    // only the four fields the fingerprint is built from.
    rememberUploadId("digest", pick("standup.wav"), "upl_1");
    expect(recallUploadId("digest", pick("standup.wav"))).toBe("upl_1");
  });

  test("a file that differs in ANY fingerprinted field is a different file", () => {
    rememberUploadId("digest", pick("standup.wav"), "upl_1");
    expect(recallUploadId("digest", pick("planning.wav"))).toBeUndefined();
    // Same name, different bytes — so a different size.
    expect(recallUploadId("digest", pick("standup.wav", "abcd"))).toBeUndefined();
    // Same name and size, edited since.
    expect(recallUploadId("digest", pick("standup.wav", "abc", 1))).toBeUndefined();
  });

  test("keys by SCOPE, so two forms on one page do not read each other's ids", () => {
    const file = pick("standup.wav");
    rememberUploadId("digest", file, "upl_digest");
    rememberUploadId("transcribe", file, "upl_transcribe");
    expect(recallUploadId("digest", file)).toBe("upl_digest");
    expect(recallUploadId("transcribe", file)).toBe("upl_transcribe");
  });

  test("keeps the most recent ids and evicts the oldest", () => {
    // 33 files against a cap of 32: the first is gone and the last is held.
    const files = Array.from({ length: 33 }, (_one, at) => pick(`take-${at}.wav`));
    for (const [at, file] of files.entries()) rememberUploadId("digest", file, `upl_${at}`);
    expect(recallUploadId("digest", files[0] as File)).toBeUndefined();
    expect(recallUploadId("digest", files[1] as File)).toBe("upl_1");
    expect(recallUploadId("digest", files[32] as File)).toBe("upl_32");
  });

  test("re-remembering a file makes it the NEWEST, not the oldest", () => {
    // The file being uploaded right now is re-written on every walk. Assigning in
    // place would leave it holding its original position, so a busy tab would
    // evict the one id most worth keeping.
    const first = pick("take-0.wav");
    rememberUploadId("digest", first, "upl_0");
    for (let at = 1; at < 32; at += 1) {
      rememberUploadId("digest", pick(`take-${at}.wav`), `upl_${at}`);
    }
    rememberUploadId("digest", first, "upl_0");
    rememberUploadId("digest", pick("take-32.wav"), "upl_32");
    expect(recallUploadId("digest", first)).toBe("upl_0");
    // `take-1` was the oldest once `take-0` moved to the end.
    expect(recallUploadId("digest", pick("take-1.wav"))).toBeUndefined();
  });

  test("ignores a payload it does not recognise rather than throwing", () => {
    // Another version of this code, or anything else that took the key.
    sessionStorage.setItem("aai:upload:digest", "not json at all");
    expect(recallUploadId("digest", pick("standup.wav"))).toBeUndefined();
    sessionStorage.setItem("aai:upload:digest", JSON.stringify(["an", "array"]));
    expect(recallUploadId("digest", pick("standup.wav"))).toBeUndefined();
    sessionStorage.setItem("aai:upload:digest", JSON.stringify({ "0:0::x.wav": 7 }));
    expect(recallUploadId("digest", pick("standup.wav"))).toBeUndefined();
  });

  test("degrades rather than throwing when storage is unavailable", () => {
    // Safari private mode and a blocking policy both throw on ACCESS, and an
    // upload that cannot be remembered must still be an upload.
    const boom = () => {
      throw new Error("SecurityError");
    };
    const file = pick("standup.wav");
    // **`Storage.prototype`, not the instance.** jsdom implements a `Storage` as a
    // PROXY over named properties, so `vi.spyOn(sessionStorage, "getItem")` is
    // taken as a write of an entry called `getItem` and the real method still
    // answers — a stub that intercepts nothing while the spec passes. Verified by
    // A/B, and `session-resume-store.test.ts` had it the ineffective way.
    // `clear` is deliberately left alone: this suite's teardown calls it.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(boom);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(boom);
    expect(() => rememberUploadId("digest", file, "upl_1")).not.toThrow();
    expect(recallUploadId("digest", file)).toBeUndefined();
    expect(() => forgetUploadId("digest", file)).not.toThrow();
  });
});
