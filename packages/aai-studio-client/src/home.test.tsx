// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The pre-project hero: a kind switcher over one big prompt box that creates a
// project from the first message. These pin the three states — ready, creating
// (inert), and status still loading — the submit paths, and the switcher, whose
// position is not decoration: it decides which system prompt the project's
// coding agent runs under, so it has to reach `onStart` with every submit.

import { fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { input } from "./_test-utils.ts";
import { HomeHero } from "./home.tsx";
import { AGENT_STARTERS, WORKFLOW_STARTERS } from "./starters.ts";

const noop = (): void => undefined;

/**
 * The first starter chip. Found by class rather than by role: every chip is a
 * button and the assertions are about WHICH prompt one carries, not its name.
 */
function starterChip(): HTMLButtonElement {
  const chip = document.querySelector("button.starter");
  if (!(chip instanceof HTMLButtonElement)) throw new Error("no starter chip rendered");
  return chip;
}

const heroProps = { creating: false, onStart: noop };

const status = { provider: "assemblyai", model: "gpt-5.5" };

describe("HomeHero states", () => {
  test("shows the prompt box and starters once the status has landed", () => {
    const html = renderToStaticMarkup(<HomeHero {...heroProps} status={status} />);
    expect(html).toContain("What should your voice agent do?");
    expect(html).toContain("Or try one of these");
    // The `disabled` attribute — Tailwind `disabled:` variant classes also
    // contain the word, so match the attribute shape.
    expect(html).not.toMatch(/<textarea[^>]*\sdisabled=/);
    expect(html).not.toMatch(/<button[^>]*class="starter"[^>]*\sdisabled=/);
  });

  test("while the project is being created, everything disables", () => {
    // A second Enter or starter click here would create a second, orphan
    // project — the whole hero must go inert until the mutation settles, the
    // switcher included (its position is baked into the pending create).
    const html = renderToStaticMarkup(<HomeHero {...heroProps} creating={true} status={status} />);
    expect(html).toContain("Creating your project…");
    expect(html).toMatch(/<textarea[^>]*\sdisabled=/);
    expect(html).toMatch(/<button[^>]*class="starter"[^>]*\sdisabled=/);
    expect(html).toMatch(/<input[^>]*type="radio"[^>]*\sdisabled=/);
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
    // The switcher stays live: there is nothing to submit yet, but choosing
    // what you are about to build costs the server nothing.
    expect(html).not.toMatch(/<input[^>]*type="radio"[^>]*\sdisabled=/);
  });

  test("shows a sample of the starters, not the whole catalog", () => {
    const html = renderToStaticMarkup(<HomeHero {...heroProps} status={status} />);
    const chips = html.match(/class="starter"/g) ?? [];
    expect(chips.length).toBe(5);
    expect(chips.length).toBeLessThan(AGENT_STARTERS.length);
  });

  test("renders no model picker or chip — the server default always runs", () => {
    const html = renderToStaticMarkup(<HomeHero {...heroProps} status={status} />);
    expect(html).not.toContain('aria-label="Model"');
    expect(html).not.toContain("Model:");
  });
});

describe("HomeHero submit", () => {
  test("Enter sends the trimmed prompt; Shift+Enter is a newline, not a send", () => {
    const onStart = vi.fn();
    render(<HomeHero creating={false} status={status} onStart={onStart} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "  build a pizza bot  " } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onStart).toHaveBeenCalledWith("build a pizza bot", "agent");
  });

  test("the send button submits, but never an empty prompt", () => {
    const onStart = vi.fn();
    render(<HomeHero creating={false} status={status} onStart={onStart} />);
    const send = screen.getByRole("button", { name: "Send" });
    fireEvent.click(send);
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "an FAQ bot" } });
    fireEvent.click(send);
    expect(onStart).toHaveBeenCalledWith("an FAQ bot", "agent");
  });

  test("a starter chip forwards its full prompt, not its label", () => {
    const onStart = vi.fn();
    render(<HomeHero creating={false} status={status} onStart={onStart} />);
    fireEvent.click(starterChip());
    expect(onStart).toHaveBeenCalledTimes(1);
    const [prompt, kind] = onStart.mock.calls[0] ?? [];
    expect(AGENT_STARTERS.map((s) => s.prompt)).toContain(prompt);
    expect(kind).toBe("agent");
  });
});

describe("HomeHero kind switcher", () => {
  /** The switcher's radios, by label. */
  const radio = (name: string) => input(name, "radio");

  /** Flip the switcher to Workflow. */
  const chooseWorkflow = () => fireEvent.click(radio("Workflow"));

  test("starts on Voice agent — the default and the common case", () => {
    render(<HomeHero {...heroProps} status={status} />);
    expect(radio("Voice agent").checked).toBe(true);
    expect(radio("Workflow").checked).toBe(false);
  });

  test("Workflow swaps the heading, the blurb, and the placeholder", () => {
    render(<HomeHero {...heroProps} status={status} />);
    chooseWorkflow();
    expect(screen.getByRole("heading").textContent).toContain("workflow");
    // The distinguishing promise of the mode: a form and a page, not a call.
    expect(document.body.textContent).toContain("a form that submits it");
    expect(screen.getByRole("textbox").getAttribute("placeholder")).toContain("uploaded recording");
  });

  test("Workflow swaps the starter chips for the workflow catalog", () => {
    render(<HomeHero {...heroProps} status={status} />);
    chooseWorkflow();
    const labels = [...document.querySelectorAll("button.starter")].map((el) => el.textContent);
    expect(labels.length).toBeGreaterThan(0);
    const workflowLabels = WORKFLOW_STARTERS.map((s) => s.label);
    for (const label of labels) expect(workflowLabels).toContain(label);
  });

  test("the chosen kind rides along with every submit path", () => {
    // The whole point of the switcher: the server stamps this on the workspace
    // and it selects the coding agent's system prompt. A hero that changed its
    // copy and sent "agent" anyway would look right and build the wrong thing.
    const onStart = vi.fn();
    render(<HomeHero creating={false} status={status} onStart={onStart} />);
    chooseWorkflow();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "transcribe uploads" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onStart).toHaveBeenLastCalledWith("transcribe uploads", "workflow");

    fireEvent.click(starterChip());
    const [prompt, kind] = onStart.mock.calls[1] ?? [];
    expect(WORKFLOW_STARTERS.map((s) => s.prompt)).toContain(prompt);
    expect(kind).toBe("workflow");
  });

  test("flipping back and forth keeps each side's sampled chips stable", () => {
    // Re-sampling on every flip would read as the chips being unrelated to the
    // position you just chose.
    render(<HomeHero {...heroProps} status={status} />);
    const chipLabels = () =>
      [...document.querySelectorAll("button.starter")].map((c) => c.textContent);
    const first = chipLabels();
    chooseWorkflow();
    fireEvent.click(screen.getByRole("radio", { name: "Voice agent" }));
    expect(chipLabels()).toEqual(first);
  });
});
