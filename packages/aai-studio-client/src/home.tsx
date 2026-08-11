// Copyright 2026 the AAI authors. MIT license.
// The home page: a project sidebar plus a centered hero with one big prompt
// box (Lovable-style). Typing into the hero creates a project and forwards
// the prompt as the first chat turn (app.tsx startWithPrompt). This replaced
// the three-step wizard canvas and the narrow guided-start chat panel.

import { useState } from "react";
import type { StudioStatus } from "./api.ts";
import { ChatStatusNote } from "./chat-status-note.tsx";
import { isEnterSubmit, SendButton } from "./send-button.tsx";
import { type ProjectKind, sampleStarters } from "./starters.ts";

/** How many starter examples the hero shows — a taste, not the catalog. */
const STARTER_SAMPLE_SIZE = 5;

/**
 * Per-kind copy for the hero. Held together in one record rather than as
 * conditionals inside the JSX, so the two modes read as two products (which they
 * are) and adding a third is a row rather than another ternary in five places.
 */
const KIND_COPY: Record<
  ProjectKind,
  { tab: string; heading: string; blurb: string; placeholder: string }
> = {
  agent: {
    tab: "Voice agent",
    heading: "What should your voice agent do?",
    blurb: "Describe it in a sentence. I'll create a project and build the first version.",
    placeholder: "A pizza-ordering agent with a live cart…",
  },
  workflow: {
    tab: "Workflow",
    heading: "What work should run in the background?",
    blurb:
      "You get a web page plus durable server-side steps that survive restarts — and an API you can call instead of the page.",
    placeholder: "A page where I upload a recording and get a transcript back…",
  },
};

const KINDS: ProjectKind[] = ["agent", "workflow"];

type HomeSidebarProps = {
  /** Undefined while the project list is loading. */
  projects: string[] | undefined;
  onSelectProject: (name: string) => void;
};

/** Home-page sidebar: previous projects (each one a chat). New projects are
 * created by the hero prompt box, so there is no button for it. */
export function HomeSidebar({ projects, onSelectProject }: HomeSidebarProps) {
  return (
    <aside className="flex w-[240px] flex-none flex-col gap-4 border-r border-line bg-panel px-4 py-5">
      <span className="eyebrow ml-2">Projects</span>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {projects === undefined && (
          <p className="m-0 px-2 text-xs leading-4 text-subtle italic">Loading projects…</p>
        )}
        {projects?.length === 0 && (
          <p className="m-0 px-2 text-xs leading-4 text-subtle">
            No projects yet. Describe your first agent to create one.
          </p>
        )}
        {projects?.map((name) => (
          <button
            type="button"
            key={name}
            className="cursor-pointer truncate rounded-md border-none bg-transparent px-2 py-2 text-left text-[13px] text-muted hover:bg-cream hover:text-fg"
            onClick={() => onSelectProject(name)}
          >
            {name}
          </button>
        ))}
      </div>
    </aside>
  );
}

type HomeHeroProps = {
  /** Undefined while `/studio/status` is loading or unreachable. */
  status: StudioStatus | undefined;
  /** A project is being created for this prompt — everything disables. */
  creating: boolean;
  /**
   * Create a project of `kind` and forward this prompt as its first message.
   *
   * The kind travels WITH the prompt rather than being read back out of some
   * shared state, because it is stamped on the project at creation and never
   * changes: the two are one decision, made once, at the same instant.
   */
  onStart: (prompt: string, kind: ProjectKind) => void;
};

export function HomeHero({ status, creating, onStart }: HomeHeroProps) {
  const [input, setInput] = useState("");
  const [kind, setKind] = useState<ProjectKind>("agent");
  // Sampled once per KIND per mount — switching tabs shows that kind's
  // examples, and switching back shows the same five rather than re-rolling
  // (which reads as the page losing its place).
  const [sampled] = useState(() => ({
    agent: sampleStarters("agent", STARTER_SAMPLE_SIZE),
    workflow: sampleStarters("workflow", STARTER_SAMPLE_SIZE),
  }));
  const starters = sampled[kind];
  const copy = KIND_COPY[kind];
  // Nothing is submittable until `/studio/status` lands: a project created
  // against a server we haven't reached yet has nowhere to send its prompt.
  const ready = status !== undefined;
  const disabled = creating || !ready;
  const submit = () => {
    const text = input.trim();
    if (!text || disabled) return;
    onStart(text, kind);
  };
  return (
    <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-9 overflow-y-auto bg-cream px-6 py-10">
      <div className="flex flex-col items-center gap-3">
        <span className="eyebrow self-center">AssemblyAI Build</span>
        {/* A tablist rather than two links: picking a kind changes what this one
            page offers, and nothing has been created yet. `aria-selected` plus
            `role` is what makes it announce as a choice rather than as two
            buttons that happen to look different. */}
        <div
          role="tablist"
          aria-label="What to build"
          className="flex gap-1 rounded-lg border border-line bg-panel p-1"
        >
          {KINDS.map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={kind === option}
              disabled={creating}
              onClick={() => setKind(option)}
              className={`cursor-pointer rounded-md border-none px-3 py-1.5 text-[13px] ${
                kind === option ? "bg-cream text-fg" : "bg-transparent text-muted hover:text-fg"
              }`}
            >
              {KIND_COPY[option].tab}
            </button>
          ))}
        </div>
        <h1 className="m-0 text-center font-serif text-[38px] leading-[1.12] font-normal text-balance">
          {copy.heading}
        </h1>
        <p className="m-0 max-w-xl text-center text-[13px] leading-5 text-muted">{copy.blurb}</p>
      </div>
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
            {starters.map((starter) => (
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
