// Copyright 2026 the AAI authors. MIT license.
// The studio's shared 60px top bar (brand, project switcher, Preview/Code
// segmented control, actions) and the Publish dropdown it opens. Split from
// app.tsx, which owns all the state these render.

import clsx from "clsx";
import logoUrl from "./assets/assemblyai-logomark.svg";

const NEW_PROJECT_SENTINEL = "__new__";

/**
 * Absolute URL of a deployed agent. The href works either way, but the *text*
 * is what people copy out or paste to a colleague, so it carries the origin
 * rather than a bare "/slug/".
 */
export function agentUrl(slug: string): string {
  return new URL(`/${slug}/`, window.location.origin).toString();
}

type PublishMenuProps = {
  open: boolean;
  busy: boolean;
  /** `aai deploy`'s output from the last publish (success or failure). */
  output?: string | undefined;
  error?: string | undefined;
  deployedSlug?: string | undefined;
  onPublish: () => void;
  onClose: () => void;
};

export function PublishMenu(props: PublishMenuProps) {
  if (!props.open) return null;
  return (
    <div className="absolute top-14 right-5 z-10 flex w-96 flex-col gap-3 rounded-lg border border-line bg-panel p-5 shadow-md">
      <span className="eyebrow">Publish</span>
      <p className="m-0 text-[13px] leading-5 text-muted">
        Runs <code className="font-mono">aai deploy</code> in the project's sandbox and ships the
        agent to PRODUCTION — the preview updates on its own as you edit; only Publish touches
        production. The CLI output lands in the chat, so the agent can fix any errors. Third-party
        keys live in the Secrets panel.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn btn-primary"
          onClick={props.onPublish}
          disabled={props.busy}
        >
          {props.busy ? "Publishing…" : "Publish"}
        </button>
        <button type="button" className="btn" onClick={props.onClose}>
          Close
        </button>
      </div>
      {(props.output ?? props.error) && (
        <pre
          className={`m-0 max-h-40 overflow-auto rounded-md border border-line bg-cream p-2 font-mono text-[11px] whitespace-pre-wrap ${props.error ? "text-err" : ""}`}
        >
          {props.error ?? props.output}
        </pre>
      )}
      {props.deployedSlug && !props.error && (
        <a
          className="font-mono text-xs break-all text-indigo"
          href={agentUrl(props.deployedSlug)}
          target="_blank"
          rel="noreferrer"
        >
          Production at {agentUrl(props.deployedSlug)}
        </a>
      )}
    </div>
  );
}

type TopBarProps = {
  project: string | null;
  projects: string[];
  tab: "preview" | "code";
  deployedSlug?: string | undefined;
  hasBuild: boolean;
  onSelectProject: (name: string | null) => void;
  onNewProject: () => void;
  /** Brand click: back to the hero home (deselects the project). */
  onGoHome: () => void;
  onSelectTab: (tab: "preview" | "code") => void;
  onSignOut: () => void;
  onTogglePublish: () => void;
  onToggleSecrets: () => void;
};

/** Shared 60px top bar (all 1x options): brand, switcher, segmented, actions. */
export function TopBar(props: TopBarProps) {
  const segClass = (active: boolean) =>
    `seg ${active ? "bg-fg text-cream" : "bg-panel text-muted hover:text-fg"}`;
  return (
    <header className="flex h-[60px] flex-none items-center gap-3.5 border-b border-line bg-panel px-5">
      <button
        type="button"
        className="flex cursor-pointer items-center gap-2.5 border-none bg-transparent p-0"
        onClick={props.onGoHome}
        title="Home"
      >
        <img src={logoUrl} alt="AssemblyAI" className="h-5 w-5" />
        <span className="font-serif text-[16px] text-fg">AssemblyAI App Builder</span>
      </button>
      <div className="h-[22px] w-px bg-line" aria-hidden />
      <div className="flex h-[34px] items-center gap-2 rounded-sm border border-line bg-panel pl-3 hover:border-line-strong">
        <span
          className={clsx(
            "h-[7px] w-[7px] flex-none rounded-full",
            props.project ? "bg-indigo" : "bg-warm-300",
          )}
          aria-hidden
        />
        <select
          className="h-full cursor-pointer border-none bg-transparent pr-2 text-[13px] text-muted focus:outline-none"
          value={props.project ?? ""}
          onChange={(e) => {
            if (e.target.value === NEW_PROJECT_SENTINEL) {
              props.onNewProject();
              return;
            }
            props.onSelectProject(e.target.value || null);
          }}
        >
          {!props.project && <option value="">No project yet</option>}
          {props.projects.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
          <option value={NEW_PROJECT_SENTINEL}>+ New project…</option>
        </select>
      </div>
      <div className="flex-1" />
      <div className="flex overflow-hidden rounded-sm border border-line">
        <button
          type="button"
          className={segClass(props.tab === "preview")}
          onClick={() => props.onSelectTab("preview")}
        >
          Preview
        </button>
        <button
          type="button"
          className={clsx("border-l border-line", segClass(props.tab === "code"))}
          onClick={() => props.onSelectTab("code")}
        >
          Code
        </button>
      </div>
      <div className="flex-1" />
      {/* The PRODUCTION URL (Publish's slug, never the preview's) — a plain
          link that opens the deployed agent in a new tab. */}
      {props.deployedSlug && (
        <a
          className="font-mono text-xs text-muted hover:text-indigo"
          href={agentUrl(props.deployedSlug)}
          target="_blank"
          rel="noreferrer"
          title={`Production: ${agentUrl(props.deployedSlug)}`}
        >
          {agentUrl(props.deployedSlug)} ↗
        </a>
      )}
      <button type="button" className="btn" onClick={props.onSignOut}>
        Change key
      </button>
      <button
        type="button"
        className="btn"
        onClick={props.onToggleSecrets}
        disabled={!props.deployedSlug}
        title={props.deployedSlug ? undefined : "Secrets unlock after the first publish"}
      >
        Secrets
      </button>
      <button
        type="button"
        className="btn btn-primary px-[18px]"
        onClick={props.onTogglePublish}
        disabled={!props.hasBuild}
        title={props.hasBuild ? undefined : "Publish unlocks after your first build"}
      >
        Publish
      </button>
    </header>
  );
}
