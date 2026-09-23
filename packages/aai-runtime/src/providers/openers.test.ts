// Copyright 2026 the AAI authors. MIT license.
/**
 * The two VALUES the opener contract carries. Everything else in `openers.ts`
 * is a type, held by `providers.test-d.ts` and by every opener that implements
 * it; these two are what a transport reads a failure's `code` off.
 */

import { describe, expect, test } from "vitest";
import { createSttError, createTtsError } from "./openers.ts";

describe("createSttError / createTtsError", () => {
  test("an STT error is a real Error carrying its phase", () => {
    const err = createSttError("stt_auth_failed", "key rejected");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("key rejected");
    expect(err.code).toBe("stt_auth_failed");
  });

  test("a TTS error is a real Error carrying its phase", () => {
    const err = createTtsError("tts_stream_error", "socket closed");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("socket closed");
    expect(err.code).toBe("tts_stream_error");
  });
});
