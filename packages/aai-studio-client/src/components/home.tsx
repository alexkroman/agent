// Copyright 2026 the AAI authors. MIT license.
// The home page: a project sidebar plus a centered hero with one big prompt
// box (Lovable-style). Typing into the hero creates a
// project and forwards the prompt as the first chat turn (app.tsx
// startWithPrompt). This replaced the three-step wizard canvas and the narrow
// guided-start chat panel.

import { type ReactNode, useEffect, useRef, useState } from "react";
import type { StudioStatus } from "../api.ts";
import { STARTERS, sampleStarters } from "../starters.ts";
import { ChatStatusNote } from "./chat-status-note.tsx";
import { CloseIcon, PlusIcon, SearchIcon, WaveIcon } from "./icons.tsx";
import { isEnterSubmit, SendButton } from "./send-button.tsx";

/** How many starter examples the hero shows — a taste, not the catalog. */
const STARTER_SAMPLE_SIZE = 5;

type HomeSidebarProps = {
  /** Undefined while the project list is loading. */
  projects: string[] | undefined;
  onSelectProject: (name: string) => void;
};

/**
 * How many projects it takes before the list needs a filter.
 *
 * A search box over six projects is noise; over fifty it is the only way to
 * find one, because studio project names share long prefixes by construction —
 * the server generates `<base>-<suffix>` (`slug-generate.ts`) and a template or
 * eval run makes many at once, so a sidebar of them truncates to near-identical
 * strings. The threshold is deliberately well above a hand-made handful.
 */
const FILTER_THRESHOLD = 12;

/** The hero's prompt box, so the sidebar's New agent button can put the cursor in it. */
export const HERO_PROMPT_ID = "hero-prompt";

/** The filter box, so the `/` shortcut and the empty state can put the cursor in it. */
const FILTER_ID = "project-filter";

/**
 * The query's terms: whitespace-separated, lowercased. EVERY term must match,
 * anywhere and in any order, so `retail zw7` finds
 * `new-retail-from-retail-zw77pm` — the base and the suffix are the two halves
 * a person remembers, and they sit at opposite ends of the name.
 */
export function filterTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchesTerms(name: string, terms: string[]): boolean {
  const lower = name.toLowerCase();
  return terms.every((t) => lower.includes(t));
}

/**
 * `name` with every occurrence of every term wrapped in `<mark>`, overlapping
 * hits merged — so a row shows WHY it survived the filter, which matters when
 * the match is the six-character suffix in the middle of a wrapped name.
 */
function highlight(name: string, terms: string[]): ReactNode {
  if (terms.length === 0) return name;
  const lower = name.toLowerCase();
  const hit = new Array<boolean>(name.length).fill(false);
  for (const t of terms) {
    for (let i = lower.indexOf(t); i !== -1; i = lower.indexOf(t, i + 1)) {
      hit.fill(true, i, i + t.length);
    }
  }
  const parts: ReactNode[] = [];
  let from = 0;
  for (let i = 1; i <= name.length; i++) {
    if (i === name.length || hit[i] !== hit[from]) {
      const text = name.slice(from, i);
      parts.push(
        hit[from] ? (
          <mark key={from} className="rounded-[2px] bg-indigo-50 text-fg">
            {text}
          </mark>
        ) : (
          text
        ),
      );
      from = i;
    }
  }
  return parts;
}

/** True when a keystroke is going into something the user is typing in. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** Home-page sidebar: previous projects (each one a chat). New projects are
 * created by the hero prompt box; the New agent button only focuses it. */
export function HomeSidebar({ projects, onSelectProject }: HomeSidebarProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const terms = filterTerms(query);
  const shown = terms.length > 0 ? projects?.filter((n) => matchesTerms(n, terms)) : projects;
  const filterable = (projects?.length ?? 0) >= FILTER_THRESHOLD;
  const total = projects?.length ?? 0;
  let count = "";
  if (total > 0) count = terms.length > 0 ? ` (${shown?.length ?? 0} of ${total})` : ` (${total})`;

  // `/` focuses the filter from anywhere on the page (GitHub's, Linear's and
  // v0's convention) — unless the keystroke is already headed into a text
  // field, so a `/` typed into the hero prompt stays a `/`.
  useEffect(() => {
    if (!filterable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filterable]);

  const rows = (): HTMLButtonElement[] =>
    Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-project]") ?? []);

  const clear = () => {
    setQuery("");
    inputRef.current?.focus();
  };

  const onFilterKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      // First Escape clears, a second one leaves the box — the browser's
      // native search-field rule, made explicit so it holds everywhere.
      if (query) {
        e.preventDefault();
        setQuery("");
      } else {
        inputRef.current?.blur();
      }
    } else if (e.key === "Enter") {
      // Enter opens the top match: type a fragment, hit Enter, done.
      const first = shown?.[0];
      if (terms.length > 0 && first !== undefined) {
        e.preventDefault();
        onSelectProject(first);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      rows()[0]?.focus();
    }
  };

  // Arrow keys walk the rows; Up from the first row returns to the filter.
  const onRowKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = rows();
    const at = all.indexOf(e.currentTarget);
    if (e.key === "ArrowDown") all[at + 1]?.focus();
    else if (at === 0) inputRef.current?.focus();
    else all[at - 1]?.focus();
  };

  return (
    <aside className="flex w-[260px] flex-none flex-col gap-2 border-r border-line bg-panel px-4 py-4">
      <button
        type="button"
        className="btn justify-start gap-2 px-2"
        onClick={() => document.getElementById(HERO_PROMPT_ID)?.focus()}
      >
        <PlusIcon size={15} />
        New agent
      </button>
      <span className="eyebrow mt-4 mb-1 ml-2" aria-live="polite">
        Projects
        {/* The COUNT, because the list scrolls: without it there is no way to
            tell twelve projects from ninety without reaching the bottom. While
            filtering it says how many survived, out of how many. */}
        {count}
      </span>
      {filterable && (
        // A quiet field in the sidebar's own surface, not a bordered form
        // input: it is navigation chrome (v0's and Lovable's Search row), and
        // a full `.field` under the eyebrow outweighed the list it filters.
        <div className="group relative flex h-8 items-center rounded-md bg-cream text-subtle ring-1 ring-transparent focus-within:bg-panel focus-within:ring-line-strong hover:ring-line">
          <span className="pointer-events-none absolute left-2.5 flex">
            <SearchIcon />
          </span>
          <input
            ref={inputRef}
            id={FILTER_ID}
            type="search"
            autoComplete="off"
            spellCheck={false}
            className="h-full w-full min-w-0 rounded-md border-none bg-transparent pr-8 pl-8 text-[13px] text-fg placeholder:text-subtle focus:outline-none [&::-webkit-search-cancel-button]:appearance-none"
            placeholder="Search projects"
            aria-label="Filter projects"
            aria-keyshortcuts="/"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onFilterKey}
          />
          {query ? (
            <button
              type="button"
              className="icon-btn absolute right-1 h-6 w-6"
              aria-label="Clear search"
              onClick={clear}
            >
              <CloseIcon size={12} />
            </button>
          ) : (
            // The shortcut, shown where the user is already looking; hidden
            // once the box has focus, where it would only be clutter.
            <kbd className="pointer-events-none absolute right-2 rounded border border-line bg-panel px-1.5 font-sans text-[11px] leading-4 text-subtle group-focus-within:hidden">
              /
            </kbd>
          )}
        </div>
      )}
      <div ref={listRef} className="-mx-2 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto">
        {projects === undefined && (
          <p className="m-0 px-4 text-xs leading-4 text-subtle italic">Loading projects…</p>
        )}
        {projects?.length === 0 && (
          <p className="m-0 px-4 text-xs leading-4 text-subtle">
            No projects yet. Describe your first agent to create one.
          </p>
        )}
        {/* A filter that matches nothing must SAY so: an empty list under a box
            with text in it otherwise reads as the projects having gone away.
            And it offers the way back, rather than leaving the user to find
            the box's clear control. */}
        {shown?.length === 0 && projects !== undefined && projects.length > 0 && (
          <div className="flex flex-col items-start gap-1 px-4 text-xs leading-4 text-subtle">
            <p className="m-0 break-all">No project matches “{query.trim()}”.</p>
            <button
              type="button"
              className="cursor-pointer border-none bg-transparent p-0 text-xs text-indigo hover:underline"
              onClick={clear}
            >
              Clear filter
            </button>
          </div>
        )}
        {shown?.map((name) => (
          <button
            type="button"
            key={name}
            data-project
            // `break-all` rather than `truncate`: these names are long and
            // share prefixes, so cutting them at the sidebar's width hid the
            // part that tells them apart. Wrapping costs a second line and
            // keeps the suffix.
            className="flex cursor-pointer items-start gap-2.5 rounded-md border-none bg-transparent px-4 py-1.5 text-left text-[13px] break-all text-muted hover:bg-cream hover:text-fg focus-visible:bg-cream focus-visible:text-fg"
            onClick={() => onSelectProject(name)}
            onKeyDown={onRowKey}
          >
            <span className="mt-0.5 text-subtle">
              <WaveIcon size={14} />
            </span>
            <span>{highlight(name, terms)}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

const COPY = {
  heading: "What should your voice agent do?",
  blurb: "Describe it in a sentence. I'll create a project and build the first version.",
  placeholder: "A pizza counter that keeps a live cart…",
};

type HomeHeroProps = {
  /** Undefined while `/studio/status` is loading or unreachable. */
  status: StudioStatus | undefined;
  /** A project is being created for this prompt — everything disables. */
  creating: boolean;
  /** Create a project and forward this prompt as its first message. */
  onStart: (prompt: string) => void;
};

export function HomeHero({ status, creating, onStart }: HomeHeroProps) {
  const [input, setInput] = useState("");
  // Sampled once per mount — a fresh random five on every page load, stable
  // across re-renders.
  const [starters] = useState(() => sampleStarters(STARTERS, STARTER_SAMPLE_SIZE));
  // Nothing is submittable until `/studio/status` lands: a project created
  // against a server we haven't reached yet has nowhere to send its prompt.
  const ready = status !== undefined;
  const disabled = creating || !ready;
  const submit = () => {
    const text = input.trim();
    if (!text || disabled) return;
    onStart(text);
  };
  return (
    <main className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-8 overflow-y-auto bg-cream px-6 py-10">
      {/* A soft indigo glow behind the prompt — the one decorative element on
          the page, so the eye lands on the box. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_45%_at_50%_42%,rgb(183_166_255/0.28),transparent_70%)]"
      />
      <div className="relative flex flex-col items-center gap-3">
        <span className="eyebrow self-center">AssemblyAI Build</span>
        <h1 className="m-0 text-center font-serif text-[44px] leading-[1.1] font-normal tracking-[-0.5px] text-balance">
          {COPY.heading}
        </h1>
        <p className="m-0 max-w-xl text-center text-[14px] leading-5 text-muted">{COPY.blurb}</p>
      </div>
      <div className="composer-card relative w-full max-w-2xl p-2 shadow-md">
        <textarea
          id={HERO_PROMPT_ID}
          className="min-h-[84px] w-full resize-none border-none bg-transparent px-3 py-2 text-[15px] leading-[22px] text-fg placeholder:text-subtle focus:outline-none"
          rows={3}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter makes a newline (isEnterSubmit's rule).
            if (isEnterSubmit(e)) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={disabled}
          placeholder={creating ? "Creating your project…" : COPY.placeholder}
        />
        <div className="flex items-center justify-between gap-2 pb-1 pl-3 pr-1">
          <span className="text-xs text-subtle">
            <kbd className="font-sans">Enter</kbd> to build ·{" "}
            <kbd className="font-sans">Shift+Enter</kbd> for a new line
          </span>
          <SendButton className="h-9 w-9" onClick={submit} disabled={disabled} />
        </div>
      </div>
      {ready && (
        <div className="relative flex flex-col items-center gap-3">
          <span className="text-xs text-subtle">Or try one of these</span>
          <div className="flex w-full max-w-3xl flex-wrap justify-center gap-2">
            {starters.map((starter) => (
              <button
                type="button"
                key={starter.label}
                className="starter"
                disabled={creating}
                onClick={() => onStart(starter.prompt)}
              >
                {starter.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="relative">
        <ChatStatusNote status={status} />
      </div>
    </main>
  );
}
