// Copyright 2026 the AAI authors. MIT license.
// The home page: a project sidebar plus a centered hero with one big prompt
// box (Lovable-style). Typing into the hero creates a
// project and forwards the prompt as the first chat turn (app.tsx
// startWithPrompt). This replaced the three-step wizard canvas and the narrow
// guided-start chat panel.

import { useState } from "react";
import type { StudioStatus } from "../api.ts";
import { STARTERS, sampleStarters } from "../starters.ts";
import { ChatStatusNote } from "./chat-status-note.tsx";
import { PlusIcon, WaveIcon } from "./icons.tsx";
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

/** Home-page sidebar: previous projects (each one a chat). New projects are
 * created by the hero prompt box; the New agent button only focuses it. */
export function HomeSidebar({ projects, onSelectProject }: HomeSidebarProps) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = needle ? projects?.filter((n) => n.toLowerCase().includes(needle)) : projects;
  const filterable = (projects?.length ?? 0) >= FILTER_THRESHOLD;

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
      <span className="eyebrow mt-4 mb-1 ml-2">
        Projects
        {/* The COUNT, because the list scrolls: without it there is no way to
            tell twelve projects from ninety without reaching the bottom. */}
        {projects !== undefined && projects.length > 0 ? ` (${projects.length})` : ""}
      </span>
      {filterable && (
        <input
          type="search"
          className="field h-8 text-[13px]"
          placeholder="Filter projects"
          aria-label="Filter projects"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <div className="-mx-2 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto">
        {projects === undefined && (
          <p className="m-0 px-4 text-xs leading-4 text-subtle italic">Loading projects…</p>
        )}
        {projects?.length === 0 && (
          <p className="m-0 px-4 text-xs leading-4 text-subtle">
            No projects yet. Describe your first agent to create one.
          </p>
        )}
        {/* A filter that matches nothing must SAY so: an empty list under a box
            with text in it otherwise reads as the projects having gone away. */}
        {shown?.length === 0 && projects !== undefined && projects.length > 0 && (
          <p className="m-0 px-4 text-xs leading-4 text-subtle">No project matches “{query}”.</p>
        )}
        {shown?.map((name) => (
          <button
            type="button"
            key={name}
            // `break-all` rather than `truncate`: these names are long and
            // share prefixes, so cutting them at the sidebar's width hid the
            // part that tells them apart. Wrapping costs a second line and
            // keeps the suffix.
            className="flex cursor-pointer items-start gap-2.5 rounded-md border-none bg-transparent px-4 py-1.5 text-left text-[13px] break-all text-muted hover:bg-cream hover:text-fg"
            onClick={() => onSelectProject(name)}
          >
            <span className="mt-0.5 text-subtle">
              <WaveIcon size={14} />
            </span>
            {name}
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
