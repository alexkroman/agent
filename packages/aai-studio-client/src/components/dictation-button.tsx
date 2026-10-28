// Copyright 2026 the AAI authors. MIT license.
// The composer's microphone: tap to record, tap again to have it transcribed
// into the prompt. The recording, the length cap, the late-answer guard and
// releasing the mic are aai-ui's `useDictation` (held by the composer, which
// owns the text it lands in); this is the button and the hint it implies.

import {
  appendDictation,
  type UseDictationOptions,
  type UseDictationResult,
  useDictation,
} from "@alexkroman1/aai-ui";
import clsx from "clsx";
import { MicIcon, SpinnerIcon } from "./icons.tsx";
import { StopIcon } from "./send-button.tsx";

/** Sends one clip to the server's dictation route; see `api.transcribeDictation`. */
export type Transcribe = UseDictationOptions["transcribe"];

/** What the composer's hint line says while dictation is doing something; null when idle. */
export function dictationStatus({ phase, error }: UseDictationResult): string | null {
  switch (phase) {
    case "starting":
      return "Waiting for the microphone…";
    case "recording":
      return "Listening — tap the square to finish";
    case "transcribing":
      return "Transcribing…";
    default:
      return error;
  }
}

/**
 * The mic button. When it is pressable is `useDictation`'s `buttonProps` (a
 * recording stays stoppable in a disabled composer; nothing is pressable
 * mid-transition) — this is only how it looks.
 */
export function DictationButton({ dictation }: { dictation: UseDictationResult }) {
  const recording = dictation.phase === "recording";
  const busy = dictation.phase === "starting" || dictation.phase === "transcribing";
  return (
    <button
      type="button"
      {...dictation.buttonProps}
      aria-label={recording ? "Stop dictation" : "Dictate"}
      title={recording ? "Stop and transcribe" : "Speak your prompt"}
      className={clsx(
        "flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded-full border-none disabled:cursor-not-allowed disabled:text-line-strong",
        recording
          ? "animate-pulse bg-err text-white"
          : "bg-transparent text-muted hover:bg-cream hover:text-fg",
      )}
    >
      <DictationIcon busy={busy} recording={recording} />
    </button>
  );
}

function DictationIcon({ busy, recording }: { busy: boolean; recording: boolean }) {
  if (busy) return <SpinnerIcon />;
  return recording ? <StopIcon /> : <MicIcon />;
}

/**
 * The composer's dictation, held by the composer because it owns the text the
 * words land in. Always runs the hook (one cannot be conditional) and it is
 * inert until started, so a composer with no `transcribe` pays nothing for it.
 */
export function useComposerDictation(
  transcribe: Transcribe | undefined,
  value: string,
  onValueChange: (value: string) => void,
  disabled: boolean,
): { dictation: UseDictationResult; enabled: boolean; status: string | null } {
  const dictation = useDictation({
    transcribe: transcribe ?? NO_TRANSCRIBE,
    // `value` is this render's, and the hook reads the latest options per call.
    onText: (text) => onValueChange(appendDictation(value, text)),
    disabled,
  });
  const enabled = transcribe != null && dictation.supported;
  return { dictation, enabled, status: enabled ? dictationStatus(dictation) : null };
}

/** The `transcribe` a composer without dictation hands the hook; never called. */
const NO_TRANSCRIBE: Transcribe = () => Promise.resolve("");
