// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * The three states of a `useDownloadUrl` result, the announced error, the
 * download attribute that two pages had each argued for in a comment, and the
 * caption track as a judgement the caller makes in both directions.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { UseDownloadUrlResult } from "../use-download-url.ts";
import { AudioResult, type AudioResultProps } from "./audio-result.tsx";

const READY: UseDownloadUrlResult = { url: "blob:http://test.local/abc", pending: false };

function mount(download: UseDownloadUrlResult, props: Partial<AudioResultProps> = {}) {
  return render(
    <AudioResult download={download} filename="summary.wav" label="Summary read aloud" {...props}>
      <p data-testid="spoken">the words</p>
    </AudioResult>,
  );
}

describe("AudioResult", () => {
  test("renders the player over the object URL, labelled, with a download link naming the file", () => {
    const { container } = mount(READY);
    const audio = container.querySelector("audio") as HTMLAudioElement;
    expect(audio.getAttribute("src")).toBe(READY.url);
    expect(audio.getAttribute("aria-label")).toBe("Summary read aloud");
    expect(audio.hasAttribute("controls")).toBe(true);
    const link = screen.getByText("Download summary.wav") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(READY.url);
    // `download` works on an object URL because the bytes are already in the
    // tab; it was the href that could not carry the bearer, not this.
    expect(link.getAttribute("download")).toBe("summary.wav");
  });

  test("says it is fetching while the bytes are in flight, with no player yet", () => {
    const { container } = mount({ pending: true });
    expect(screen.getByText("Fetching the audio…")).toBeDefined();
    expect(container.querySelector("audio")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("announces a failed read", () => {
    const { container } = mount({ pending: false, error: "upload not found" });
    expect(screen.getByRole("alert").textContent).toBe(
      "Could not load the audio: upload not found",
    );
    expect(container.querySelector("audio")).toBeNull();
  });

  test("renders nothing for an idle result but the heading and the children", () => {
    // No id yet: the page's spoken text still reads, and nothing claims a
    // download is happening.
    const { container } = mount({ pending: false }, { heading: "Read aloud" });
    expect(container.querySelector("audio")).toBeNull();
    expect(screen.queryByText("Fetching the audio…")).toBeNull();
    expect(screen.getByText("Read aloud").tagName).toBe("H3");
    expect(screen.getByTestId("spoken")).toBeDefined();
  });

  test("the heading is optional, and the children come after the player", () => {
    const { container } = mount(READY);
    expect(container.querySelector("h3")).toBeNull();
    const audio = container.querySelector("audio") as Node;
    const spoken = screen.getByTestId("spoken");
    expect(audio.compareDocumentPosition(spoken) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("no `captions` means no <track> — a deliberate omission, not a default", () => {
    const { container } = mount(READY);
    expect(container.querySelector("track")).toBeNull();
  });

  test("`captions` renders one default caption cue spanning the clip, as a WebVTT data URL", () => {
    const { container } = mount(READY, {
      captions: { text: "Hello, world.", durationMs: 61_500 },
    });
    const track = container.querySelector("track") as HTMLTrackElement;
    expect(track.getAttribute("kind")).toBe("captions");
    expect(track.hasAttribute("default")).toBe(true);
    expect(track.getAttribute("srclang")).toBe("en");
    // The track's label defaults to the player's.
    expect(track.getAttribute("label")).toBe("Summary read aloud");
    const src = track.getAttribute("src") ?? "";
    expect(src.startsWith("data:text/vtt;charset=utf-8,")).toBe(true);
    const vtt = decodeURIComponent(src.slice("data:text/vtt;charset=utf-8,".length));
    // `hh:mm:ss.mmm` — the only timestamp shape WebVTT accepts.
    expect(vtt).toBe("WEBVTT\n\n00:00:00.000 --> 00:01:01.500\nHello, world.\n");
  });

  test("`captions` may name its own label and language", () => {
    const { container } = mount(READY, {
      captions: { text: "Hola", durationMs: 1000, label: "Resumen", srcLang: "es" },
    });
    const track = container.querySelector("track") as HTMLTrackElement;
    expect(track.getAttribute("label")).toBe("Resumen");
    expect(track.getAttribute("srclang")).toBe("es");
  });

  test("className is appended to the section's own classes", () => {
    const { container } = mount(READY, { className: "mt-4" });
    const section = container.firstElementChild as HTMLElement;
    expect(section.tagName).toBe("SECTION");
    expect(section.className).toBe("flex flex-col gap-2 mt-4");
  });
});
