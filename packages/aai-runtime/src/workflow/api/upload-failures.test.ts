// Copyright 2026 the AAI authors. MIT license.
// Which status each upload refusal is answered with, and that anything else
// is left to the router.

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { expect, test, vi } from "vitest";
import {
  UnknownUploadError,
  UploadCompleteError,
  UploadIdTakenError,
  UploadPartError,
  UploadsUnavailableError,
  UploadTooLargeError,
} from "../uploads.ts";
import { sendUploadFailure } from "./upload-failures.ts";

function response() {
  const res = new ServerResponse(new IncomingMessage(new Socket()));
  const writeHead = vi.spyOn(res, "writeHead");
  const end = vi.spyOn(res, "end");
  return {
    res,
    status: () => writeHead.mock.calls[0]?.[0],
    body: () => JSON.parse(String(end.mock.calls[0]?.[0])),
  };
}

test.each<[string, Error, number]>([
  ["unavailable", new UploadsUnavailableError("set AAI_UPLOAD_STORAGE_BUCKET"), 501],
  ["too large", new UploadTooLargeError(10), 413],
  ["id taken", new UploadIdTakenError("upl_1"), 409],
  ["complete", new UploadCompleteError("upl_1"), 409],
  ["bad part", new UploadPartError("misaligned"), 400],
  ["unknown", new UnknownUploadError("upl_1"), 404],
])("%s is answered %i with its own message", (_label, err, status) => {
  const r = response();
  expect(sendUploadFailure(r.res, err)).toBe(true);
  expect(r.status()).toBe(status);
  expect(r.body()).toEqual({ error: err.message });
});

test("anything else is NOT answered, so the router's catch can report a 500", () => {
  const r = response();
  expect(sendUploadFailure(r.res, new Error("connect ECONNREFUSED"))).toBe(false);
  expect(r.status()).toBeUndefined();
});
