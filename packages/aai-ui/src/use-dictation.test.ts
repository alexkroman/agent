// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * `useDictation` over a fake recorder: a recording is transcribed and handed
 * back, the microphone is released on every way out, a late answer lands
 * nowhere, and the length cap stops the clip by itself.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DictationRecorder } from "./audio/index.ts";
import {
  type OpenDictationRecorder,
  type UseDictationOptions,
  useDictationWith,
} from "./use-dictation.ts";

const WAV = new Uint8Array([82, 73, 70, 70]);

function fakeRecorder() {
  const rec = {
    sampleRate: 16_000,
    stop: vi.fn(async () => WAV),
    cancel: vi.fn(async () => undefined),
  } satisfies DictationRecorder;
  const open = vi.fn<OpenDictationRecorder>(async () => rec);
  return { rec, open };
}

function mount(open: OpenDictationRecorder, over: Partial<UseDictationOptions> = {}) {
  const onText = vi.fn<(text: string) => void>();
  const transcribe = vi.fn<UseDictationOptions["transcribe"]>(async () => "  hello there ");
  const hook = renderHook(() => useDictationWith({ transcribe, onText, ...over }, open));
  return { hook, onText, transcribe };
}

/** Let the recorder's open and the transcription settle. */
const settle = () => act(() => vi.advanceTimersByTimeAsync(0));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useDictation", () => {
  test("toggle records, toggle again transcribes the clip and hands back the trimmed text", async () => {
    const { rec, open } = fakeRecorder();
    const { hook, onText, transcribe } = mount(open);

    act(() => hook.result.current.toggle());
    expect(hook.result.current.phase).toBe("starting");
    await settle();
    expect(hook.result.current.phase).toBe("recording");
    expect(open).toHaveBeenCalledWith({ sampleRate: 16_000, maxSeconds: 120 });

    act(() => hook.result.current.toggle());
    expect(hook.result.current.phase).toBe("transcribing");
    await settle();

    expect(rec.stop).toHaveBeenCalledOnce();
    const audio = transcribe.mock.calls[0]?.[0];
    expect(audio?.type).toBe("audio/wav");
    expect(onText).toHaveBeenCalledWith("hello there");
    expect(hook.result.current.phase).toBe("idle");
  });

  test("an empty transcript types nothing", async () => {
    const { open } = fakeRecorder();
    const { hook, onText } = mount(open, { transcribe: async () => "   " });
    act(() => hook.result.current.start());
    await settle();
    act(() => hook.result.current.stop());
    await settle();
    expect(onText).not.toHaveBeenCalled();
    expect(hook.result.current).toMatchObject({ phase: "idle", error: null });
  });

  test("a failed transcription is shown as error, and start clears it", async () => {
    const { open } = fakeRecorder();
    const { hook, onText } = mount(open, {
      transcribe: async () => {
        throw new Error("HTTP 401");
      },
    });
    act(() => hook.result.current.start());
    await settle();
    act(() => hook.result.current.stop());
    await settle();
    expect(onText).not.toHaveBeenCalled();
    expect(hook.result.current).toMatchObject({ phase: "idle", error: "HTTP 401" });

    act(() => hook.result.current.start());
    expect(hook.result.current.error).toBeNull();
    await settle();
  });

  test("a denied microphone is an error, not a stuck 'starting'", async () => {
    const open = vi.fn<OpenDictationRecorder>(async () => {
      throw new Error("Permission denied");
    });
    const { hook } = mount(open);
    act(() => hook.result.current.start());
    await settle();
    expect(hook.result.current).toMatchObject({ phase: "idle", error: "Permission denied" });
  });

  test("cancel while transcribing aborts the request and drops its answer", async () => {
    const { open } = fakeRecorder();
    let signal: AbortSignal | undefined;
    let answer: (text: string) => void = () => undefined;
    const { hook, onText } = mount(open, {
      transcribe: (_audio, opts) => {
        signal = opts.signal;
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    });
    act(() => hook.result.current.start());
    await settle();
    act(() => hook.result.current.stop());
    await settle();
    act(() => hook.result.current.cancel());
    expect(signal?.aborted).toBe(true);
    answer("too late");
    await settle();
    expect(onText).not.toHaveBeenCalled();
    expect(hook.result.current.phase).toBe("idle");
  });

  test("cancel while the microphone is still opening releases it once granted", async () => {
    const { rec, open } = fakeRecorder();
    const { hook } = mount(open);
    act(() => hook.result.current.start());
    act(() => hook.result.current.cancel());
    await settle();
    expect(rec.cancel).toHaveBeenCalledOnce();
    expect(hook.result.current.phase).toBe("idle");
  });

  test("the length cap stops and transcribes the clip by itself", async () => {
    const { rec, open } = fakeRecorder();
    const { hook, onText } = mount(open, { maxSeconds: 5 });
    act(() => hook.result.current.start());
    await settle();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(rec.stop).toHaveBeenCalledOnce();
    expect(onText).toHaveBeenCalledWith("hello there");
  });

  test("an unmount mid-recording releases the microphone", async () => {
    const { rec, open } = fakeRecorder();
    const { hook } = mount(open);
    act(() => hook.result.current.start());
    await settle();
    hook.unmount();
    expect(rec.cancel).toHaveBeenCalledOnce();
  });

  test("buttonProps: toggles, says pressed while recording, and takes no press mid-transition", async () => {
    const { open } = fakeRecorder();
    const { hook } = mount(open);
    expect(hook.result.current.buttonProps).toMatchObject({
      disabled: false,
      "aria-pressed": false,
    });

    act(() => hook.result.current.buttonProps.onClick());
    expect(hook.result.current.buttonProps.disabled).toBe(true); // starting
    await settle();
    expect(hook.result.current.buttonProps).toMatchObject({
      disabled: false,
      "aria-pressed": true,
    });

    act(() => hook.result.current.buttonProps.onClick());
    expect(hook.result.current.buttonProps.disabled).toBe(true); // transcribing
    await settle();
    expect(hook.result.current.buttonProps).toMatchObject({
      disabled: false,
      "aria-pressed": false,
    });
  });

  test("disabled refuses a new recording but keeps a running one stoppable", async () => {
    const { rec, open } = fakeRecorder();
    let disabled = false;
    const onText = vi.fn<(text: string) => void>();
    const hook = renderHook(() =>
      useDictationWith({ transcribe: async () => "kept", onText, disabled }, open),
    );

    act(() => hook.result.current.start());
    await settle();
    disabled = true;
    hook.rerender();
    // Recording: still stoppable, and what was said is not lost.
    expect(hook.result.current.buttonProps.disabled).toBe(false);
    act(() => hook.result.current.buttonProps.onClick());
    await settle();
    expect(rec.stop).toHaveBeenCalledOnce();
    expect(onText).toHaveBeenCalledWith("kept");

    // Idle and disabled: no new recording.
    expect(hook.result.current.buttonProps.disabled).toBe(true);
    act(() => hook.result.current.start());
    expect(hook.result.current.phase).toBe("idle");
    expect(open).toHaveBeenCalledOnce();
  });
});
