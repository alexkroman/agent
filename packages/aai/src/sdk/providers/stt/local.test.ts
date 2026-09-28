// Copyright 2026 the AAI authors. MIT license.
/** Unit test for the `localStt()` descriptor and its resolved settings. */

import { describe, expect, test } from "vitest";
import {
  LOCAL_STT_DEFAULT_MAX_TURN_SILENCE_MS,
  LOCAL_STT_DEFAULT_MIN_TURN_SILENCE_MS,
  LOCAL_STT_DEFAULT_URL,
  LOCAL_STT_KIND,
  localStt,
  resolveLocalSttSettings,
} from "./local.ts";

describe("localStt", () => {
  test("returns a pure descriptor that copies its options", () => {
    const options = { url: "ws://model:9000", apiKeyEnv: "MODEL_TOKEN" };
    const descriptor = localStt(options);
    expect(descriptor).toEqual({ kind: LOCAL_STT_KIND, options });
    expect(descriptor.options).not.toBe(options);
  });

  test("takes no options", () => {
    expect(localStt()).toEqual({ kind: "local", options: {} });
  });
});

describe("resolveLocalSttSettings", () => {
  test("fills every default and omits an unset language", () => {
    expect(resolveLocalSttSettings({})).toEqual({
      url: LOCAL_STT_DEFAULT_URL,
      minTurnSilenceMs: LOCAL_STT_DEFAULT_MIN_TURN_SILENCE_MS,
      maxTurnSilenceMs: LOCAL_STT_DEFAULT_MAX_TURN_SILENCE_MS,
    });
  });

  test("keeps explicit values", () => {
    expect(
      resolveLocalSttSettings({
        url: "ws://model:9000",
        minTurnSilenceMs: 300,
        maxTurnSilenceMs: 1500,
        language: "English",
      }),
    ).toEqual({
      url: "ws://model:9000",
      minTurnSilenceMs: 300,
      maxTurnSilenceMs: 1500,
      language: "English",
    });
  });
});
