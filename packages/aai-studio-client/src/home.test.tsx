// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The pre-project hero: one big prompt box that creates a project from the
// first message. These pin the three states — ready, creating (inert), and
// status still loading — and the submit paths.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { HomeHero } from "./home.tsx";
import { AGENT_STARTERS, WORKFLOW_STARTERS } from "./starters.ts";

const noop = (): void => undefined;

const heroProps = { creating: false, onStart: noop };

afterEach(cleanup);

describe("HomeHero states", () => {
  test("shows the prompt box and starters once the status has landed", () => {
    const html = renderToStaticMarkup(
      <HomeHero {...heroProps} status={{ provider: "assemblyai", model: "gpt-5.5" }} />,
    );
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
      <HomeHero
        {...heroProps}
        creating={true}
        status={{ provider: "assemblyai", model: "gpt-5.5" }}
      />,
    );
    expect(html).toContain("Creating your project…");
    expect(html).toMatch(/<textarea[^>]*\sdisabled=/);
    expect(html).toMatch(/<button[^>]*class="starter"[^>]*\sdisabled=/);
  });

  test("unknown status reads as 'checking', and nothing is submittable yet", () => {
    // /studio/status still loading or unreachable. The hero says what it is
    // waiting for rather than offering a prompt box that would create a
    // project against a server nobody has reached.
    const html = renderToStaticMarkup(<HomeHero {...heroProps} status={undefined} />);
    // renderToStaticMarkup escapes the apostrophe — match around it.
    expect(html).toContain("chat status…");
    expect(html).not.toContain("Or try one of these");
    expect(html).toMatch(/<textarea[^>]*\sdisabled=/);
  });

  test("shows a sample of the starters, not the whole catalog", () => {
    const html = renderToStaticMarkup(
      <HomeHero {...heroProps} status={{ provider: "assemblyai", model: "gpt-5.5" }} />,
    );
    const chips = html.match(/class="starter"/g) ?? [];
    expect(chips.length).toBe(5);
    expect(chips.length).toBeLessThan(AGENT_STARTERS.length);
  });

  test("renders no model picker or chip — the server default always runs", () => {
    const html = renderToStaticMarkup(
      <HomeHero {...heroProps} status={{ provider: "assemblyai", model: "gpt-5.5" }} />,
    );
    expect(html).not.toContain('aria-label="Model"');
    expect(html).not.toContain("Model:");
  });
});

describe("HomeHero submit", () => {
  test("Enter sends the trimmed prompt; Shift+Enter is a newline, not a send", () => {
    const onStart = vi.fn();
    render(
      <HomeHero
        creating={false}
        status={{ provider: "assemblyai", model: "gpt-5.5" }}
        onStart={onStart}
      />,
    );
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "  build a pizza bot  " } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onStart).toHaveBeenCalledWith("build a pizza bot", "agent");
  });

  test("the send button submits, but never an empty prompt", () => {
    const onStart = vi.fn();
    render(
      <HomeHero
        creating={false}
        status={{ provider: "assemblyai", model: "gpt-5.5" }}
        onStart={onStart}
      />,
    );
    const send = screen.getByRole("button", { name: "Send" });
    fireEvent.click(send);
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "an FAQ bot" } });
    fireEvent.click(send);
    expect(onStart).toHaveBeenCalledWith("an FAQ bot", "agent");
  });

  test("a starter chip forwards its full prompt, not its label", () => {
    const onStart = vi.fn();
    render(
      <HomeHero
        creating={false}
        status={{ provider: "assemblyai", model: "gpt-5.5" }}
        onStart={onStart}
      />,
    );
    const chip = document.querySelector("button.starter") as HTMLButtonElement;
    fireEvent.click(chip);
    expect(onStart).toHaveBeenCalledTimes(1);
    const sent = onStart.mock.calls[0]?.[0];
    expect(AGENT_STARTERS.map((s) => s.prompt)).toContain(sent);
    // The KIND travels with the prompt: it is stamped on the project at
    // creation and selects the coding agent's system prompt, so a chip that
    // forwarded only the text would create the wrong kind of project.
    expect(onStart.mock.calls[0]?.[1]).toBe("agent");
  });

  test("the Workflow tab switches the heading, the placeholder and the starters", () => {
    const onStart = vi.fn();
    render(
      <HomeHero
        creating={false}
        status={{ provider: "assemblyai", model: "gpt-5.5" }}
        onStart={onStart}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Workflow" }));

    expect(screen.getByText("What work should run in the background?")).toBeTruthy();
    // The starters come from the workflow pool now — the whole point of the
    // toggle, since the two kinds get different system prompts.
    const chip = document.querySelector("button.starter") as HTMLButtonElement;
    expect(WORKFLOW_STARTERS.map((s) => s.label)).toContain(chip.textContent);

    fireEvent.click(chip);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(WORKFLOW_STARTERS.map((s) => s.prompt)).toContain(onStart.mock.calls[0]?.[0]);
    expect(onStart.mock.calls[0]?.[1]).toBe("workflow");
  });

  test("typed text is submitted with the selected kind", () => {
    const onStart = vi.fn();
    render(
      <HomeHero
        creating={false}
        status={{ provider: "assemblyai", model: "gpt-5.5" }}
        onStart={onStart}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Workflow" }));
    const box = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "batch process my csv" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onStart).toHaveBeenCalledWith("batch process my csv", "workflow");
  });
});
