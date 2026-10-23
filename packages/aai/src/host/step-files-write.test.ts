// Copyright 2026 the AAI authors. MIT license.
import { expect, onTestFinished, test, vi } from "vitest";
import { publishUploadReader } from "../sdk/step-uploads.ts";
import { readUploadToFile, stepFilesFs } from "./step-files.ts";

// No filesystem access: the handle models legal short writes at explicit offsets.
test.each([true, false])("finishes short writes with explicit size: %s", async (explicitSize) => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const landed = new Uint8Array(bytes.length);
  publishUploadReader({
    info: async (id) => ({ id, name: "", type: "", size: bytes.length, complete: true }),
    read: async (_id, start, end) => bytes.slice(start, end),
  });
  onTestFinished(() => publishUploadReader(undefined));
  const write = vi.fn(
    async (buffer: Uint8Array, offset: number, length: number, position: number) => {
      const bytesWritten = Math.min(2, length);
      landed.set(buffer.subarray(offset, offset + bytesWritten), position);
      return { bytesWritten, buffer };
    },
  );
  const close = vi.fn(async () => undefined);
  vi.spyOn(stepFilesFs, "open").mockResolvedValue({
    write,
    close,
    read: async () => {
      throw new Error("Unexpected read");
    },
    truncate: async () => undefined,
  });
  const options = explicitSize ? { size: bytes.length, windowBytes: 3 } : { windowBytes: 3 };
  expect(await readUploadToFile("upl_short", "unused", options)).toBe(bytes.length);
  expect(landed).toEqual(bytes);
  expect(write).toHaveBeenCalledTimes(4);
  expect(close).toHaveBeenCalledOnce();
});

test.each([true, false])(
  "refuses a zero-progress write with explicit size: %s",
  async (explicitSize) => {
    publishUploadReader({
      info: async (id) => ({ id, name: "", type: "", size: 1, complete: true }),
      read: async () => new Uint8Array([1]),
    });
    onTestFinished(() => publishUploadReader(undefined));
    const write = vi.fn(async () => ({ bytesWritten: 0 }));
    const close = vi.fn(async () => undefined);
    vi.spyOn(stepFilesFs, "open").mockResolvedValue({
      write,
      close,
      read: async () => {
        throw new Error("Unexpected read");
      },
      truncate: async () => undefined,
    });
    await expect(
      readUploadToFile("upl_short", "unused", explicitSize ? { size: 1 } : {}),
    ).rejects.toThrow("File write made no progress");
    expect(write).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  },
);
