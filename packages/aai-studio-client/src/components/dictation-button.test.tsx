// Copyright 2026 the AAI authors. MIT license.
// The composer's mic button and the hint it implies: what each dictation phase
// says, which glyph and label the button wears, and that a recording can
// always be stopped while a new one waits for a live composer.

import type { UseDictationResult } from "@alexkroman1/aai-ui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { DictationButton, dictationStatus } from "./dictation-button.tsx";

const noop = (): void => undefined;
/** The `disabled` ATTRIBUTE — the class list says `disabled:` too. */
const DISABLED = /<button[^>]*\sdisabled=/;

function dictation(over: Partial<UseDictationResult> = {}): UseDictationResult {
  return {
    phase: "idle",
    error: null,
    supported: true,
    start: noop,
    stop: noop,
    cancel: noop,
    toggle: noop,
    ...over,
  };
}

describe("dictationStatus", () => {
  test("says what each phase is waiting on, and nothing when idle", () => {
    expect(dictationStatus(dictation())).toBeNull();
    expect(dictationStatus(dictation({ phase: "starting" }))).toMatch(/microphone/);
    expect(dictationStatus(dictation({ phase: "recording" }))).toMatch(/Listening/);
    expect(dictationStatus(dictation({ phase: "transcribing" }))).toBe("Transcribing…");
  });

  test("an idle hook with a failure reports the failure", () => {
    expect(dictationStatus(dictation({ error: "HTTP 401" }))).toBe("HTTP 401");
  });
});

describe("DictationButton", () => {
  const render = (d: UseDictationResult, disabled = false) =>
    renderToStaticMarkup(<DictationButton dictation={d} disabled={disabled} />);

  test("idle: an enabled Dictate button", () => {
    const html = render(dictation());
    expect(html).toContain('aria-label="Dictate"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toMatch(DISABLED);
  });

  test("recording: a pressed Stop dictation button, live even in a disabled composer", () => {
    const html = render(dictation({ phase: "recording" }), true);
    expect(html).toContain('aria-label="Stop dictation"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toMatch(DISABLED);
  });

  test("a disabled composer starts no new recording, and a busy one takes no press", () => {
    expect(render(dictation(), true)).toMatch(DISABLED);
    expect(render(dictation({ phase: "transcribing" }))).toMatch(DISABLED);
    expect(render(dictation({ phase: "starting" }))).toMatch(DISABLED);
  });
});
