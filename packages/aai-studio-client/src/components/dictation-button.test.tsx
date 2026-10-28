// Copyright 2026 the AAI authors. MIT license.
// The composer's mic button and the hint it implies: what each dictation phase
// says, and that the button wears the hook's `buttonProps` under the studio's
// labels. WHEN it is pressable is aai-ui's rule (`use-dictation.test.ts`).

import type { UseDictationResult } from "@alexkroman1/aai-ui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { DictationButton, dictationStatus } from "./dictation-button.tsx";

const noop = (): void => undefined;
/** The `disabled` ATTRIBUTE — the class list says `disabled:` too. */
const DISABLED = /<button[^>]*\sdisabled=/;

function dictation(over: Partial<UseDictationResult> = {}): UseDictationResult {
  const phase = over.phase ?? "idle";
  return {
    buttonProps: {
      onClick: noop,
      disabled: phase === "starting" || phase === "transcribing",
      "aria-pressed": phase === "recording",
    },
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
  const render = (d: UseDictationResult) => renderToStaticMarkup(<DictationButton dictation={d} />);

  test("idle: an enabled Dictate button", () => {
    const html = render(dictation());
    expect(html).toContain('aria-label="Dictate"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toMatch(DISABLED);
  });

  test("recording: a pressed Stop dictation button", () => {
    const html = render(dictation({ phase: "recording" }));
    expect(html).toContain('aria-label="Stop dictation"');
    expect(html).toContain('aria-pressed="true"');
  });

  test("the hook's buttonProps decide whether it is pressable", () => {
    expect(render(dictation({ phase: "transcribing" }))).toMatch(DISABLED);
    const refused = dictation();
    expect(render({ ...refused, buttonProps: { ...refused.buttonProps, disabled: true } })).toMatch(
      DISABLED,
    );
  });
});
