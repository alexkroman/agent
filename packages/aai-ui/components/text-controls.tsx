// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

import { errorMessage } from "@alexkroman1/aai";
import clsx from "clsx";
import { memo, useRef, useState } from "react";
import { useSessionCore, useSessionSelector } from "../context.ts";
import { ERROR_COLOR } from "./_colors.ts";
import { Button } from "./button.tsx";
import { SessionUrlChips } from "./url-chips.tsx";

/**
 * Controls for a text-only session (`tts: none()`): a **record** toggle that
 * streams the microphone while active, an **upload** button that transcribes
 * an audio file, and **New Conversation**. Replies arrive as text in the
 * {@link MessageList} — there is no playback side.
 *
 * Rendered automatically by {@link ChatView} when the server declares the
 * session text-only; custom clients can compose it directly.
 *
 * @public
 */
// memo(): string-only props, so parent re-renders don't cascade — only the
// `recording`/`state` selectors below trigger re-renders.
export const TextControls = memo(function TextControls({
  className,
}: {
  className?: string | undefined;
}) {
  const recording = useSessionSelector((s) => s.recording);
  const state = useSessionSelector((s) => s.state);
  const core = useSessionCore();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const connected = state !== "disconnected" && state !== "connecting" && state !== "error";

  function toggleRecording(): void {
    if (recording) core.stopRecording();
    else core.startRecording();
  }

  function onFileChosen(file: File | undefined): void {
    if (!file || uploading) return;
    setUploading(true);
    setUploadError(null);
    core
      .sendAudioFile(file)
      .catch((err: unknown) => {
        setUploadError(errorMessage(err));
      })
      .finally(() => {
        setUploading(false);
        // Allow re-selecting the same file.
        if (fileInput.current) fileInput.current.value = "";
      });
  }

  return (
    <div className={clsx("flex flex-col gap-1.5 shrink-0", className)}>
      <div className="flex items-center gap-2">
        <Button
          variant={recording ? "default" : "secondary"}
          onClick={toggleRecording}
          disabled={!connected || uploading}
          aria-pressed={recording}
          style={recording ? { background: ERROR_COLOR } : undefined}
          data-testid="record-button"
        >
          <span
            className={clsx("w-2 h-2 rounded-full mr-2", recording && "animate-pulse")}
            style={{ background: recording ? "#fff" : ERROR_COLOR }}
          />
          {recording ? "Stop recording" : "Record"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => fileInput.current?.click()}
          disabled={!connected || uploading}
          data-testid="upload-button"
        >
          {uploading ? "Transcribing…" : "Upload audio"}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(e) => onFileChosen(e.target.files?.[0])}
          data-testid="upload-input"
        />
        <Button variant="ghost" onClick={core.reset}>
          New Conversation
        </Button>
        <SessionUrlChips className="ml-auto max-w-[55%]" />
      </div>
      {uploadError && (
        <div className="text-[12px]" style={{ color: ERROR_COLOR }} data-testid="upload-error">
          {uploadError}
        </div>
      )}
    </div>
  );
});
