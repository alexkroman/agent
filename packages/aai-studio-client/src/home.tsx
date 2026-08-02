// Copyright 2026 the AAI authors. MIT license.
// The home page: a project sidebar plus a centered hero with one big prompt
// box (Lovable-style). Typing into the hero creates a project and forwards
// the prompt as the first chat turn (app.tsx startWithPrompt). This replaced
// the three-step wizard canvas and the narrow guided-start chat panel.

import { useState } from "react";
import type { StudioStatus } from "./api.ts";
import { sampleStarters } from "./starters.ts";

/** How many starter examples the hero shows — a taste, not the catalog. */
const STARTER_SAMPLE_SIZE = 5;

type HomeSidebarProps = {
  /** Undefined while the project list is loading. */
  projects: string[] | undefined;
  onSelectProject: (name: string) => void;
  onNewProject: () => void;
};

/** Home-page sidebar: previous projects (each one a chat) + new project. */
export function HomeSidebar({ projects, onSelectProject, onNewProject }: HomeSidebarProps) {
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
      <button type="button" className="btn" onClick={onNewProject}>
        + New project
      </button>
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
  const llmReady = status?.llm === true;
  const disabled = creating || !llmReady;
  const submit = () => {
    const text = input.trim();
    if (!text || disabled) return;
    onStart(text);
  };
  return (
    <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-9 overflow-y-auto bg-cream px-6 py-10">
      <div className="flex flex-col items-center gap-3">
        <span className="eyebrow self-center">AssemblyAI App Builder</span>
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
            // Enter sends, Shift+Enter makes a newline; isComposing means
            // Enter is confirming an IME candidate, not the message.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
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
          <button
            type="button"
            aria-label="Send"
            className="flex h-9 w-9 flex-none cursor-pointer items-center justify-center rounded-sm border-none bg-indigo text-white hover:bg-indigo-hover disabled:cursor-not-allowed disabled:bg-disabled disabled:text-line-strong"
            onClick={submit}
            disabled={disabled}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden
            >
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>
      {llmReady && (
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
      {/* No status yet is loading or a network failure — either way, don't
          claim the server is misconfigured. */}
      {status === undefined && (
        <p className="m-0 text-xs leading-4 text-subtle">Checking the server's chat status…</p>
      )}
      {status !== undefined && !status.llm && (
        <p className="m-0 max-w-md text-center text-xs leading-4 text-subtle">
          Chat is disabled: this server has no LLM key (ASSEMBLYAI_API_KEY or ANTHROPIC_API_KEY).
          The Code view and Publish still work.
        </p>
      )}
    </main>
  );
}
