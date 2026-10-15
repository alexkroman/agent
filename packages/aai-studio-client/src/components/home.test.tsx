// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The pre-project hero: one big prompt box that creates a project from the
// first message. These pin the three states — ready, creating (inert), and
// status still loading — and the submit paths.

import { fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { STARTERS } from "../starters.ts";
import { filterTerms, HomeHero, HomeSidebar, matchesTerms } from "./home.tsx";

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
    // project — the whole hero must go inert until the mutation settles.
    const html = renderToStaticMarkup(<HomeHero {...heroProps} creating={true} status={status} />);
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
    const html = renderToStaticMarkup(<HomeHero {...heroProps} status={status} />);
    const chips = html.match(/class="starter"/g) ?? [];
    expect(chips.length).toBe(5);
    expect(chips.length).toBeLessThan(STARTERS.length);
  });

  test("renders no model picker or chip — the server default always runs", () => {
    const html = renderToStaticMarkup(<HomeHero {...heroProps} status={status} />);
    expect(html).not.toContain('aria-label="Model"');
    expect(html).not.toContain("Model:");
  });
});

describe("HomeHero submit", () => {
  test("Enter sends the trimmed prompt; Shift+Enter is a newline, not a send", async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    render(<HomeHero creating={false} status={status} onStart={onStart} />);
    const box = screen.getByRole("textbox");
    await user.type(box, "  build a pizza bot  {Shift>}{Enter}{/Shift}");
    expect(onStart).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(onStart).toHaveBeenCalledWith("build a pizza bot");
  });

  test("the send button submits, but never an empty prompt", async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    render(<HomeHero creating={false} status={status} onStart={onStart} />);
    const send = screen.getByRole("button", { name: "Send" });
    fireEvent.click(send);
    expect(onStart).not.toHaveBeenCalled();
    await user.type(screen.getByRole("textbox"), "an FAQ bot");
    fireEvent.click(send);
    expect(onStart).toHaveBeenCalledWith("an FAQ bot");
  });

  test("a starter chip forwards its full prompt, not its label", () => {
    const onStart = vi.fn();
    render(<HomeHero creating={false} status={status} onStart={onStart} />);
    fireEvent.click(starterChip());
    expect(onStart).toHaveBeenCalledTimes(1);
    const [prompt] = onStart.mock.calls[0] ?? [];
    expect(STARTERS.map((s) => s.prompt)).toContain(prompt);
  });
});

/**
 * The sidebar with MANY projects.
 *
 * Studio project names share long prefixes by construction — the server
 * generates `<base>-<suffix>`, and a template or eval run makes many at once —
 * so a long list truncates to near-identical strings with no way to narrow it.
 * These pin the three parts of the answer: the count, the filter's threshold,
 * and that a filter matching nothing SAYS so rather than looking like the
 * projects went away.
 */
describe("HomeSidebar with a long list", () => {
  const many = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => `use-transcript-workflow-${String(i).padStart(2, "0")}`);

  test("shows the count, because the list scrolls", () => {
    render(<HomeSidebar projects={many(30)} onSelectProject={noop} />);
    expect(screen.getByText(/Projects \(30\)/)).toBeInTheDocument();
  });

  test("offers no filter for a handful", () => {
    // A search box over six projects is noise.
    render(<HomeSidebar projects={many(6)} onSelectProject={noop} />);
    expect(screen.queryByLabelText("Filter projects")).toBeNull();
  });

  test("filters the list down, matching anywhere in the name", async () => {
    const user = userEvent.setup();
    render(<HomeSidebar projects={[...many(20), "bedtime-story-reader"]} onSelectProject={noop} />);
    await user.type(screen.getByLabelText("Filter projects"), "bedtime");

    expect(screen.getByRole("button", { name: "bedtime-story-reader" })).toBeInTheDocument();
    // The 20 that do not match are gone, not merely reordered.
    expect(screen.queryByRole("button", { name: "use-transcript-workflow-00" })).toBeNull();
  });

  test("says so when the filter matches nothing", async () => {
    const user = userEvent.setup();
    render(<HomeSidebar projects={many(20)} onSelectProject={noop} />);
    await user.type(screen.getByLabelText("Filter projects"), "nothing-matches-this");

    expect(screen.getByText(/No project matches/)).toBeInTheDocument();
  });

  test("a filtered row still selects the project it names", async () => {
    const user = userEvent.setup();
    const onSelectProject = vi.fn();
    render(
      <HomeSidebar projects={[...many(20), "sweep-agent"]} onSelectProject={onSelectProject} />,
    );
    await user.type(screen.getByLabelText("Filter projects"), "sweep");
    fireEvent.click(screen.getByRole("button", { name: "sweep-agent" }));

    expect(onSelectProject).toHaveBeenCalledWith("sweep-agent");
  });

  test("every term must match, in any order — base and suffix together", async () => {
    const user = userEvent.setup();
    const names = [...many(20), "new-retail-from-retail-zw77pm", "new-retail-from-retail-ab12cd"];
    render(<HomeSidebar projects={names} onSelectProject={noop} />);
    await user.type(screen.getByLabelText("Filter projects"), "zw7 retail");

    expect(
      screen.getByRole("button", { name: "new-retail-from-retail-zw77pm" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "new-retail-from-retail-ab12cd" })).toBeNull();
    // The count says how many survived, out of how many.
    expect(screen.getByText(/Projects \(1 of 22\)/)).toBeInTheDocument();
  });

  test("marks the matched part of each surviving name", async () => {
    const user = userEvent.setup();
    render(<HomeSidebar projects={[...many(20), "sweep-agent"]} onSelectProject={noop} />);
    await user.type(screen.getByLabelText("Filter projects"), "SWEEP");

    const marks = Array.from(document.querySelectorAll("mark"), (m) => m.textContent);
    expect(marks).toEqual(["sweep"]);
  });

  test("Enter opens the top match", async () => {
    const user = userEvent.setup();
    const onSelectProject = vi.fn();
    render(
      <HomeSidebar projects={[...many(20), "sweep-agent"]} onSelectProject={onSelectProject} />,
    );
    await user.type(screen.getByLabelText("Filter projects"), "sweep{Enter}");

    expect(onSelectProject).toHaveBeenCalledWith("sweep-agent");
  });

  test("Enter in an empty filter opens nothing", async () => {
    const user = userEvent.setup();
    const onSelectProject = vi.fn();
    render(<HomeSidebar projects={many(20)} onSelectProject={onSelectProject} />);
    await user.type(screen.getByLabelText("Filter projects"), "{Enter}");

    expect(onSelectProject).not.toHaveBeenCalled();
  });

  test("Escape clears the filter, then leaves the box", async () => {
    const user = userEvent.setup();
    render(<HomeSidebar projects={many(20)} onSelectProject={noop} />);
    const box = screen.getByLabelText("Filter projects");
    await user.type(box, "07{Escape}");
    expect(box).toHaveValue("");
    expect(box).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(box).not.toHaveFocus();
  });

  test("the × button and the empty state's link both reset the filter", async () => {
    const user = userEvent.setup();
    render(<HomeSidebar projects={many(20)} onSelectProject={noop} />);
    const box = screen.getByLabelText("Filter projects");

    await user.type(box, "nope");
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(box).toHaveValue("");

    await user.type(box, "nope");
    await user.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(box).toHaveValue("");
    expect(screen.getAllByRole("button", { name: /use-transcript-workflow/ })).toHaveLength(20);
  });

  test("/ focuses the filter, but not while typing in another field", async () => {
    const user = userEvent.setup();
    render(
      <>
        <textarea aria-label="Prompt" />
        <HomeSidebar projects={many(20)} onSelectProject={noop} />
      </>,
    );
    const box = screen.getByLabelText("Filter projects");
    const prompt = screen.getByLabelText("Prompt");

    await user.click(prompt);
    await user.keyboard("/");
    expect(prompt).toHaveValue("/");
    expect(box).not.toHaveFocus();

    prompt.blur();
    await user.keyboard("/");
    expect(box).toHaveFocus();
    expect(box).toHaveValue("");
  });

  test("ArrowDown walks from the filter into the rows and ArrowUp walks back", async () => {
    const user = userEvent.setup();
    render(<HomeSidebar projects={many(20)} onSelectProject={noop} />);
    const box = screen.getByLabelText("Filter projects");
    await user.click(box);

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: "use-transcript-workflow-00" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: "use-transcript-workflow-01" })).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(box).toHaveFocus();
  });
});

describe("project filter terms", () => {
  test("splits on whitespace, lowercases, and drops empties", () => {
    expect(filterTerms("  Retail   ZW7 ")).toEqual(["retail", "zw7"]);
    expect(filterTerms("   ")).toEqual([]);
  });

  test("matches only when every term is present", () => {
    expect(matchesTerms("new-retail-from-retail-zw77pm", ["zw7", "retail"])).toBe(true);
    expect(matchesTerms("new-retail-from-retail-zw77pm", ["zw7", "pizza"])).toBe(false);
    expect(matchesTerms("anything", [])).toBe(true);
  });
});
