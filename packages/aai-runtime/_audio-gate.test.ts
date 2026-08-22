// Copyright 2026 the AAI authors. MIT license.
// Unit specs for the provider-facing audio backpressure gate.

import { MAX_PROVIDER_WS_BUFFERED_BYTES } from "@alexkroman1/aai/host-internal";
import { describe, expect, test } from "vitest";
import { createAudioSendGate } from "./_audio-gate.ts";
import { makeLogger } from "./_test-utils.ts";

const OVER_CAP = MAX_PROVIDER_WS_BUFFERED_BYTES + 1;

describe("createAudioSendGate", () => {
  test("never drops when the socket exposes no bufferedAmount", () => {
    const log = makeLogger();
    const gate = createAudioSendGate({ bufferedAmount: () => undefined, label: "X", log });
    expect(gate.shouldDrop()).toBe(false);
    expect(gate.shouldDrop()).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("passes frames while the buffer is at or under the cap", () => {
    const log = makeLogger();
    const gate = createAudioSendGate({
      bufferedAmount: () => MAX_PROVIDER_WS_BUFFERED_BYTES,
      label: "X",
      log,
    });
    expect(gate.shouldDrop()).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("drops past the cap and warns once per stall, not per frame", () => {
    const log = makeLogger();
    const gate = createAudioSendGate({ bufferedAmount: () => OVER_CAP, label: "X", log });
    expect(gate.shouldDrop()).toBe(true);
    expect(gate.shouldDrop()).toBe(true);
    expect(gate.shouldDrop()).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      "X: provider audio backlog exceeded; dropping frames",
      expect.objectContaining({ bufferedBytes: OVER_CAP }),
    );
  });

  test("resumes once the buffer drains, logging the transition out", () => {
    const log = makeLogger();
    let buffered = OVER_CAP;
    const gate = createAudioSendGate({ bufferedAmount: () => buffered, label: "X", log });
    expect(gate.shouldDrop()).toBe(true);
    buffered = 0;
    expect(gate.shouldDrop()).toBe(false);
    expect(gate.shouldDrop()).toBe(false);
    expect(log.debug).toHaveBeenCalledTimes(1);
  });

  test("a second stall after draining warns again", () => {
    const log = makeLogger();
    let buffered = OVER_CAP;
    const gate = createAudioSendGate({ bufferedAmount: () => buffered, label: "X", log });
    expect(gate.shouldDrop()).toBe(true);
    buffered = 0;
    expect(gate.shouldDrop()).toBe(false);
    buffered = OVER_CAP;
    expect(gate.shouldDrop()).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});
