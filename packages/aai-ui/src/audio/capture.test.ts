// Copyright 2026 the AAI authors. MIT license.
/**
 * The capture primitives both capture paths share: the rate assertion, the
 * failed-init release, and the capture node's start/stop/chunk protocol.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  type AudioMockContext,
  fakeMediaStream,
  findWorkletNode,
  installAudioMocks,
  tick,
} from "../_react-test-utils.ts";
import {
  assertGranted,
  createCaptureNode,
  releaseStreamOnFailure,
  workletCrash,
} from "./capture.ts";

describe("assertGranted", () => {
  test("passes a granted rate and names the side of a refused one", () => {
    expect(() => assertGranted(16_000, 16_000, "capture")).not.toThrow();
    expect(() => assertGranted(48_000, 16_000, "capture")).toThrow(
      "Browser refused the capture sample rate: asked for 16000 Hz, got 48000 Hz",
    );
  });
});

describe("releaseStreamOnFailure", () => {
  test("stops every track of a stream granted after the failure", async () => {
    const stop = vi.fn();
    releaseStreamOnFailure(Promise.resolve(fakeMediaStream({ stop })));
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  });

  test("is a no-op when the grant itself was refused", async () => {
    // No unhandled rejection escapes: the helper swallows the refusal.
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    expect(() =>
      releaseStreamOnFailure(Promise.reject(new Error("NotAllowedError"))),
    ).not.toThrow();
    await tick();
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe("workletCrash", () => {
  test("names the side and logs it", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(workletCrash("capture").message).toBe("Audio capture worklet crashed");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("createCaptureNode", () => {
  let audio: AudioMockContext;
  beforeEach(() => {
    audio = installAudioMocks();
  });

  test("relays chunks and the dead-mic report, and stop() waits for the ack", async () => {
    const onChunk = vi.fn();
    const onSilent = vi.fn();
    const capture = createCaptureNode(new AudioContext(), onChunk, onSilent);
    const node = findWorkletNode(audio.workletNodes(), "capture-processor");

    capture.start();
    const buffer = new ArrayBuffer(4);
    node.port.simulateMessage({ event: "chunk", buffer });
    node.port.simulateMessage({ event: "silent" });
    // The mock port acks a `stop` with `stopped`, as the worklet does.
    await capture.stop();

    expect(onChunk).toHaveBeenCalledWith(buffer);
    expect(onSilent).toHaveBeenCalledOnce();
    expect(node.port.posted).toEqual([{ event: "start" }, { event: "stop" }]);
  });
});
