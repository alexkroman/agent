// Copyright 2026 the AAI authors. MIT license.
// The home page: a project sidebar plus a centered hero with one big prompt
// box (Lovable-style). Typing into the hero creates a project and forwards
// the prompt as the first chat turn (app.tsx startWithPrompt). This replaced
// the three-step wizard canvas and the narrow guided-start chat panel.

import { useState } from "react";
import type { StudioStatus } from "./api.ts";
import { ChatStatusNote } from "./chat-status-note.tsx";
import { isEnterSubmit, SendButton } from "./send-button.tsx";
import { sampleStarters } from "./starters.ts";

/** How many starter examples the hero shows — a taste, not the catalog. */
const STARTER_SAMPLE_SIZE = 5;

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
  /** Create a project and forward this prompt as its first message. */
  onStart: (prompt: string) => void;
};

export function HomeHero({ status, creating, onStart }: HomeHeroProps) {
  const [input, setInput] = useState("");
  // Sampled once per mount — a fresh random five on every page load.
  const [starters] = useState(() => sampleStarters(STARTER_SAMPLE_SIZE));
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
    <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-9 overflow-y-auto bg-cream px-6 py-10">
      <div className="flex flex-col items-center gap-3">
        <span className="eyebrow self-center">AssemblyAI Build</span>
        <h1 className="m-0 text-center font-serif text-[38px] leading-[1.12] font-normal text-balance">
          What should your voice agent do?
        </h1>
        <p className="m-0 text-center text-[13px] leading-5 text-muted">
          Describe it in a sentence. I'll create a project and build the first version.
        </p>
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
          placeholder={
            creating ? "Creating your project…" : "A pizza-ordering agent with a live cart…"
          }
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
                onClick={() => onStart(starter.prompt)}
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
