// Copyright 2026 the AAI authors. MIT license.
// The home page: a project sidebar plus a centered hero with a kind switcher
// and one big prompt box (Lovable-style). Typing into the hero creates a
// project and forwards the prompt as the first chat turn (app.tsx
// startWithPrompt). This replaced the three-step wizard canvas and the narrow
// guided-start chat panel.

import clsx from "clsx";
import { useState } from "react";
import type { ProjectKind, StudioStatus } from "./api.ts";
import { ChatStatusNote } from "./chat-status-note.tsx";
import { SEG_GROUP, segItemClass } from "./segmented.ts";
import { isEnterSubmit, SendButton } from "./send-button.tsx";
import { STARTERS, sampleStarters } from "./starters.ts";

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

/** Home-page sidebar: previous projects (each one a chat). New projects are
 * created by the hero prompt box, so there is no button for it. */
export function HomeSidebar({ projects, onSelectProject }: HomeSidebarProps) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = needle ? projects?.filter((n) => n.toLowerCase().includes(needle)) : projects;
  const filterable = (projects?.length ?? 0) >= FILTER_THRESHOLD;

  return (
    <aside className="flex w-[240px] flex-none flex-col gap-4 border-r border-line bg-panel px-4 py-5">
      <span className="eyebrow ml-2">
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
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {projects === undefined && (
          <p className="m-0 px-2 text-xs leading-4 text-subtle italic">Loading projects…</p>
        )}
        {projects?.length === 0 && (
          <p className="m-0 px-2 text-xs leading-4 text-subtle">
            No projects yet. Describe your first agent to create one.
          </p>
        )}
        {/* A filter that matches nothing must SAY so: an empty list under a box
            with text in it otherwise reads as the projects having gone away. */}
        {shown?.length === 0 && projects !== undefined && projects.length > 0 && (
          <p className="m-0 px-2 text-xs leading-4 text-subtle">No project matches “{query}”.</p>
        )}
        {shown?.map((name) => (
          <button
            type="button"
            key={name}
            // `break-all` rather than `truncate`: these names are long and
            // share prefixes, so cutting them at 240px hid the part that tells
            // them apart. Wrapping costs a second line and keeps the suffix.
            className="cursor-pointer break-all rounded-md border-none bg-transparent px-2 py-2 text-left text-[13px] text-muted hover:bg-cream hover:text-fg"
            onClick={() => onSelectProject(name)}
          >
            {name}
          </button>
        ))}
      </div>
    </aside>
  );
}

/**
 * What each switcher position says and builds.
 *
 * The copy is per KIND rather than shared-with-a-noun-swapped because the two
 * products are described by different sentences: a voice agent is told what to
 * DO ("what should it do?", one sentence of persona), and a workflow app is
 * asked for a JOB plus what comes back. The placeholder is the strongest hint
 * either way, so each names something the mode can really build.
 */
type KindCopy = {
  /** Switcher label — a noun, so the two positions read as two products. */
  label: string;
  heading: string;
  blurb: string;
  placeholder: string;
};

const KIND_COPY: Record<ProjectKind, KindCopy> = {
  agent: {
    label: "Voice agent",
    heading: "What should your voice agent do?",
    blurb: "Describe it in a sentence. I'll create a project and build the first version.",
    placeholder: "A pizza-ordering agent with a live cart…",
  },
  workflow: {
    label: "Workflow",
    heading: "What job should your workflow run?",
    blurb:
      "Describe the job. I'll build a form that submits it and a page that watches the run — no phone call involved.",
    placeholder: "Transcribe an uploaded recording and file the transcript…",
  },
};

/** Switcher order. Voice agent first: it is the default and the common case. */
const KIND_ORDER: ProjectKind[] = ["agent", "workflow"];

type HomeHeroProps = {
  /** Undefined while `/studio/status` is loading or unreachable. */
  status: StudioStatus | undefined;
  /** A project is being created for this prompt — everything disables. */
  creating: boolean;
  /**
   * Create a project of `kind` and forward this prompt as its first message.
   * The kind rides along because it is not a UI preference: the server stamps
   * it on the workspace, where it selects the coding agent's system prompt for
   * the life of the project.
   */
  onStart: (prompt: string, kind: ProjectKind) => void;
};

export function HomeHero({ status, creating, onStart }: HomeHeroProps) {
  const [input, setInput] = useState("");
  const [kind, setKind] = useState<ProjectKind>("agent");
  // Sampled once per mount PER KIND — a fresh random five on every page load,
  // and stable while the user flips the switcher back and forth (a re-sample on
  // every flip would read as the chips being unrelated to the position).
  const [starters] = useState(() => ({
    agent: sampleStarters(STARTERS.agent, STARTER_SAMPLE_SIZE),
    workflow: sampleStarters(STARTERS.workflow, STARTER_SAMPLE_SIZE),
  }));
  // Nothing is submittable until `/studio/status` lands: a project created
  // against a server we haven't reached yet has nowhere to send its prompt.
  const ready = status !== undefined;
  const disabled = creating || !ready;
  const copy = KIND_COPY[kind];
  const submit = () => {
    const text = input.trim();
    if (!text || disabled) return;
    onStart(text, kind);
  };
  return (
    <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-9 overflow-y-auto bg-cream px-6 py-10">
      <div className="flex flex-col items-center gap-3">
        <span className="eyebrow self-center">AssemblyAI Build</span>
        <h1 className="m-0 text-center font-serif text-[38px] leading-[1.12] font-normal text-balance">
          {copy.heading}
        </h1>
        <p className="m-0 max-w-xl text-center text-[13px] leading-5 text-muted">{copy.blurb}</p>
      </div>
      {/* A radio group, not tabs: this picks what will be BUILT rather than
          revealing a panel, and it is a `fieldset` so the grouping and the
          accessible name come from the markup. Each option is a real radio —
          arrow keys move between them — with the segmented look on its label. */}
      <fieldset className={clsx("m-0 flex-none p-0", SEG_GROUP)}>
        <legend className="sr-only">What to build</legend>
        {KIND_ORDER.map((id, i) => (
          <label
            key={id}
            className={clsx(
              "seg flex cursor-pointer items-center",
              segItemClass(kind === id, i),
              creating && "cursor-not-allowed opacity-60",
            )}
          >
            <input
              type="radio"
              name="project-kind"
              value={id}
              className="sr-only"
              checked={kind === id}
              // Only `creating` disables the switcher, not `disabled`: with the
              // status still loading there is nothing to submit, but choosing
              // what you are about to build costs the server nothing.
              disabled={creating}
              onChange={() => setKind(id)}
            />
            {KIND_COPY[id].label}
          </label>
        ))}
      </fieldset>
      <div className="flex w-full max-w-2xl flex-col gap-2 rounded-lg border border-line bg-panel p-3 shadow-md focus-within:border-line-strong">
        <textarea
          className="min-h-[72px] w-full resize-none border-none bg-transparent px-1.5 py-1 text-[14px] leading-[21px] text-fg placeholder:text-subtle focus:outline-none"
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
          placeholder={creating ? "Creating your project…" : copy.placeholder}
        />
        <div className="flex items-center justify-end">
          <SendButton className="h-9 w-9" onClick={submit} disabled={disabled} />
        </div>
      </div>
      {ready && (
        <div className="flex flex-col items-center gap-3">
          <span className="text-xs text-subtle">Or try one of these</span>
          <div className="flex w-full max-w-3xl flex-wrap justify-center gap-2">
            {starters[kind].map((starter) => (
              <button
                type="button"
                key={starter.label}
                className="starter"
                disabled={creating}
                onClick={() => onStart(starter.prompt, kind)}
              >
                {starter.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <ChatStatusNote status={status} />
    </main>
  );
}
