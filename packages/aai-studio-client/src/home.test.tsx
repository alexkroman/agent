// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The pre-project hero: one big prompt box that creates a project from the
// first message. These pin the four states — ready, creating (inert), status
// still loading, a server with no LLM key — and the submit paths.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { HomeHero } from "./home.tsx";
import { STARTERS } from "./starters.ts";

const noop = (): void => undefined;

const heroProps = { creating: false, onStart: noop };

afterEach(cleanup);

describe("HomeHero states", () => {
  test("shows the prompt box and starters when the server has an LLM", () => {
    const html = renderToStaticMarkup(<HomeHero {...heroProps} status={{ llm: true }} />);
    expect(html).toContain("What should your voice agent do?");
    expect(html).toContain("Or try one of these");
    // The `disabled` attribute — Tailwind `disabled:` variant classes also
    // contain the word, so match the attribute shape.
    expect(html).not.toMatch(/<textarea[^>]*\sdisabled=/);
    expect(html).not.toMatch(/<button[^>]*class="starter"[^>]*\sdisabled=/);
  });

  test("while the project is being created, everything disables", () => {
    // A second Enter or starter click here would create a second, orphan
    // project — the whole hero must go inert until the mutation settles.
    const html = renderToStaticMarkup(
      <HomeHero {...heroProps} creating={true} status={{ llm: true }} />,
    );
    expect(html).toContain("Creating your project…");
    expect(html).toMatch(/<textarea[^>]*\sdisabled=/);
    expect(html).toMatch(/<button[^>]*class="starter"[^>]*\sdisabled=/);
  });

  test("unknown status reads as 'checking', not as a misconfigured server", () => {
    // /studio/status still loading or unreachable — a network blip must not
    // claim the server has no LLM key.
    const html = renderToStaticMarkup(<HomeHero {...heroProps} status={undefined} />);
    // renderToStaticMarkup escapes the apostrophe — match around it.
    expect(html).toContain("chat status…");
    expect(html).not.toContain("Chat is disabled");
    expect(html).toMatch(/<textarea[^>]*\sdisabled=/);
  });

  test("a definite no-LLM status shows the configuration message", () => {
    const html = renderToStaticMarkup(<HomeHero {...heroProps} status={{ llm: false }} />);
    expect(html).toContain("Chat is disabled");
    expect(html).not.toContain("Or try one of these");
    expect(html).toMatch(/<textarea[^>]*\sdisabled=/);
  });

  test("shows a sample of the starters, not the whole catalog", () => {
    const html = renderToStaticMarkup(<HomeHero {...heroProps} status={{ llm: true }} />);
    const chips = html.match(/class="starter"/g) ?? [];
    expect(chips.length).toBe(5);
    expect(chips.length).toBeLessThan(STARTERS.length);
  });

  test("renders no model picker or chip — the server default always runs", () => {
    const html = renderToStaticMarkup(
      <HomeHero {...heroProps} status={{ llm: true, provider: "assemblyai", model: "gpt-5.5" }} />,
    );
    expect(html).not.toContain('aria-label="Model"');
    expect(html).not.toContain("Model:");
  });
});

describe("HomeHero submit", () => {
  test("Enter sends the trimmed prompt; Shift+Enter is a newline, not a send", () => {
    const onStart = vi.fn();
    render(<HomeHero creating={false} status={{ llm: true }} onStart={onStart} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "  build a pizza bot  " } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onStart).toHaveBeenCalledWith("build a pizza bot");
  });

  test("the send button submits, but never an empty prompt", () => {
    const onStart = vi.fn();
    render(<HomeHero creating={false} status={{ llm: true }} onStart={onStart} />);
    const send = screen.getByRole("button", { name: "Send" });
    fireEvent.click(send);
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "an FAQ bot" } });
    fireEvent.click(send);
    expect(onStart).toHaveBeenCalledWith("an FAQ bot");
  });

  test("a starter chip forwards its full prompt, not its label", () => {
    const onStart = vi.fn();
    render(<HomeHero creating={false} status={{ llm: true }} onStart={onStart} />);
    const chip = document.querySelector("button.starter") as HTMLButtonElement;
    fireEvent.click(chip);
    expect(onStart).toHaveBeenCalledTimes(1);
    const sent = onStart.mock.calls[0]?.[0];
    expect(STARTERS.map((s) => s.prompt)).toContain(sent);
  });
});
