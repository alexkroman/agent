// Copyright 2026 the AAI authors. MIT license.
// The studio's shared 60px top bar (brand, project name, Preview/Code
// segmented control, Settings, Publish, Log out) and the Publish dropdown it
// opens.
// Split from app.tsx, which owns all the state these render. Project
// switching lives in the home sidebar (brand → home), not here.

import clsx from "clsx";
import { useRef } from "react";
import { ACCOUNT_MENU_ID, ACCOUNT_TOGGLE_ATTR } from "./account-menu.tsx";
import logoUrl from "./assets/assemblyai-logomark.svg";
import { useDismissablePanel } from "./dismissable.ts";

/**
 * Absolute URL of a deployed agent. The href works either way, but the *text*
 * is what people copy out or paste to a colleague, so it carries the origin
 * rather than a bare "/slug/".
 */
export function agentUrl(slug: string): string {
  return new URL(`/${slug}/`, window.location.origin).toString();
}

/** Tooltip while a chat turn is streaming and Publish is locked. */
const PUBLISH_WAIT_FOR_TURN = "Publish unlocks when the agent finishes its turn";

/**
 * Links the top bar's toggle to the panel it opens (`aria-controls`), and
 * marks the toggle so the dismiss-on-outside-click handler can tell "clicked
 * away" from "pressed the toggle again" (see dismissable.ts).
 */
const PUBLISH_MENU_ID = "publish-menu";
const PUBLISH_TOGGLE_ATTR = "data-publish-toggle";

type PublishMenuProps = {
  open: boolean;
  busy: boolean;
  /**
   * A chat turn is streaming. Publishing waits for the turn to settle — the
   * preview deploys only on the end-of-turn workspace sync, and Publish must
   * not ship the half-finished tree a mid-turn checkpoint can leave behind.
   */
  chatBusy?: boolean;
  /** `aai deploy`'s output from the last publish (success or failure). */
  output?: string | undefined;
  error?: string | undefined;
  deployedSlug?: string | undefined;
  onPublish: () => void;
  onClose: () => void;
};

/**
 * The Publish dropdown. Deliberately says each thing ONCE: the top bar's
 * toggle is the panel's heading (so there is no eyebrow) and its pressed
 * state is the dismiss control (so there is no Close button), and a
 * successful deploy is reported as the production LINK alone — the raw
 * `aai deploy` transcript repeats that URL twice more, so it is folded away
 * behind a disclosure. It also lands in the chat, which is where the coding
 * agent reads it from. A FAILED deploy stays expanded: the error is the
 * result, not a detail.
 */
export function PublishMenu(props: PublishMenuProps) {
  const panel = useRef<HTMLDivElement>(null);
  const { open, onClose } = props;

  // With Close gone, dismissal is Escape or a click away from the panel.
  // The toggle exempts itself (see PUBLISH_TOGGLE_ATTR).
  useDismissablePanel({ open, onClose, panel, toggleAttr: PUBLISH_TOGGLE_ATTR });

  if (!open) return null;
  const published = props.deployedSlug && !props.error;
  return (
    <div
      ref={panel}
      id={PUBLISH_MENU_ID}
      role="dialog"
      aria-label="Publish"
      className="absolute top-14 right-5 z-10 flex w-96 flex-col gap-3 rounded-lg border border-line bg-panel p-5 shadow-md"
    >
      <p className="m-0 text-[13px] leading-5 text-muted">
        Ships the current workspace to production with <code className="font-mono">aai deploy</code>
        . The preview updates on its own as you edit — only this touches production. Output lands in
        the chat so the agent can fix any errors; third-party keys live under Settings.
      </p>
      <button
        type="button"
        className="btn btn-primary self-start"
        onClick={props.onPublish}
        disabled={props.busy || props.chatBusy}
        title={props.chatBusy && !props.busy ? PUBLISH_WAIT_FOR_TURN : undefined}
      >
        {props.busy ? "Publishing…" : "Publish"}
      </button>
      {published && (
        <a
          className="font-mono text-xs break-all text-indigo"
          href={agentUrl(props.deployedSlug as string)}
          target="_blank"
          rel="noreferrer"
        >
          {agentUrl(props.deployedSlug as string)} ↗
        </a>
      )}
      {props.error && (
        <pre className="m-0 max-h-40 overflow-auto rounded-md border border-line bg-cream p-2 font-mono text-[11px] whitespace-pre-wrap text-err">
          {props.error}
        </pre>
      )}
      {props.output && !props.error && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer select-none">CLI output</summary>
          <pre className="m-0 mt-2 max-h-40 overflow-auto rounded-md border border-line bg-cream p-2 font-mono text-[11px] whitespace-pre-wrap">
            {props.output}
          </pre>
        </details>
      )}
    </div>
  );
}

/**
 * The three project panes, all peers in the segmented control.
 *
 * Settings joined them rather than staying a dropdown: it holds secrets, the
 * CLI round-trip, and Delete project, which is more than a floating panel can
 * lay out. Nothing here gates on a build or a deploy — Delete project has to
 * work before anything has ever been published.
 */
export type StudioTab = "preview" | "code" | "analytics" | "settings";

const TABS: { id: StudioTab; label: string }[] = [
  { id: "preview", label: "Preview" },
  { id: "code", label: "Code" },
  { id: "analytics", label: "Analytics" },
  { id: "settings", label: "Settings" },
];

type TopBarProps = {
  project: string | null;
  tab: StudioTab;
  deployedSlug?: string | undefined;
  hasBuild: boolean;
  /** A chat turn is streaming — Publish locks until it settles (see PublishMenuProps). */
  chatBusy?: boolean;
  /**
   * The Publish menu is showing. The button is a TOGGLE, so it has to look
   * pressed while it is: it is the panel's only dismiss control now, and a
   * primary button that reads identical open and closed gives no hint that
   * pressing it again hides what it just opened.
   */
  publishOpen?: boolean;
  /** The Account panel is showing — same toggle semantics as Publish. */
  accountOpen?: boolean;
  /** Brand click: back to the hero home (deselects the project). */
  onGoHome: () => void;
  onSelectTab: (tab: StudioTab) => void;
  onLogOut: () => void;
  onTogglePublish: () => void;
  onToggleAccount: () => void;
};

/** Shared 60px top bar (all 1x options): brand, project name, segmented, actions. */
export function TopBar(props: TopBarProps) {
  const segClass = (active: boolean) =>
    clsx("seg", active ? "bg-fg text-cream" : "bg-panel text-muted hover:text-fg");
  let publishTitle: string | undefined;
  if (!props.hasBuild) publishTitle = "Publish unlocks after your first build";
  else if (props.chatBusy) publishTitle = PUBLISH_WAIT_FOR_TURN;
  else if (props.publishOpen) publishTitle = "Hide the publish menu";
  return (
    <header className="flex h-[60px] flex-none items-center gap-3.5 border-b border-line bg-panel px-5">
      <button
        type="button"
        className="flex flex-none cursor-pointer items-center gap-2.5 border-none bg-transparent p-0"
        onClick={props.onGoHome}
        title="Home"
      >
        <img src={logoUrl} alt="AssemblyAI" className="h-5 w-5" />
        {/* The wordmark is the first thing to go when the bar runs out of
            room — the logo still identifies the app. `lg`, not `md`: the bar
            needs ~830px for everything else, so hiding it only below 768
            left the 768–830 band still overflowing. */}
        <span className="hidden font-serif text-[16px] whitespace-nowrap text-fg lg:inline">
          AssemblyAI Build
        </span>
      </button>
      {props.project && (
        <>
          <div className="h-[22px] w-px flex-none bg-line" aria-hidden />
          <div className="flex h-[34px] min-w-0 items-center gap-2 pl-1">
            <span className="h-[7px] w-[7px] flex-none rounded-full bg-indigo" aria-hidden />
            <span className="truncate text-[13px] text-muted" title={props.project}>
              {props.project}
            </span>
          </div>
        </>
      )}
      <div className="flex-1" />
      {/* The pane switcher is project-scoped — the hero home has no panes. */}
      {props.project && (
        <div className="flex flex-none overflow-hidden rounded-sm border border-line">
          {TABS.map((entry, i) => (
            <button
              key={entry.id}
              type="button"
              aria-current={props.tab === entry.id ? "page" : undefined}
              className={clsx(i > 0 && "border-l border-line", segClass(props.tab === entry.id))}
              onClick={() => props.onSelectTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1" />
      {/* The PRODUCTION URL (Publish's slug, never the preview's) — a plain
          link that opens the deployed agent in a new tab. */}
      {props.deployedSlug && (
        <a
          // `min-w-0`: a flex item defaults to min-width:auto, so `truncate`
          // alone could not shrink it and the action buttons overflowed the
          // viewport instead (measured: 829px of bar in a 768px window).
          className="max-w-80 min-w-0 truncate font-mono text-xs whitespace-nowrap text-muted hover:text-indigo"
          href={agentUrl(props.deployedSlug)}
          target="_blank"
          rel="noreferrer"
          title={`Production: ${agentUrl(props.deployedSlug)}`}
        >
          {agentUrl(props.deployedSlug)} ↗
        </a>
      )}
      <button
        type="button"
        {...{ [PUBLISH_TOGGLE_ATTR]: "" }}
        className={clsx(
          "btn btn-primary flex items-center gap-2 px-[18px]",
          // Pressed: darker face, inset shadow, and the caret flipped — the
          // three together read as "this is held down, press again to close".
          props.publishOpen &&
            "border-indigo-hover bg-indigo-hover shadow-[inset_0_2px_4px_rgb(20_18_12/0.35)]",
        )}
        onClick={props.onTogglePublish}
        disabled={!props.hasBuild || props.chatBusy}
        title={publishTitle}
        aria-haspopup="dialog"
        aria-expanded={props.publishOpen ?? false}
        aria-controls={props.publishOpen ? PUBLISH_MENU_ID : undefined}
      >
        Publish
        <span aria-hidden className="text-[8px] leading-none">
          {props.publishOpen ? "▲" : "▼"}
        </span>
      </button>
      {/* Account-scoped, so it sits outside the project panes and is here on
          the home screen too — where the API key would otherwise be
          unreachable. */}
      <button
        type="button"
        {...{ [ACCOUNT_TOGGLE_ATTR]: "" }}
        className={clsx("btn", props.accountOpen && "border-fg text-fg")}
        onClick={props.onToggleAccount}
        title="Your AssemblyAI account key"
        aria-haspopup="dialog"
        aria-expanded={props.accountOpen ?? false}
        aria-controls={props.accountOpen ? ACCOUNT_MENU_ID : undefined}
      >
        Account
      </button>
      <button type="button" className="btn" onClick={props.onLogOut}>
        Log out
      </button>
    </header>
  );
}
