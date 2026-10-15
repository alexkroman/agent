// Copyright 2026 the AAI authors. MIT license.
// The studio's shared top bar (brand, the open project, the canvas controls,
// Publish, Account), the Publish dropdown it opens, and the pane tabs the bar
// carries over the canvas. Split from app.tsx, which owns all the state these
// render. Project switching lives in the home sidebar (brand → home), not here.

import clsx from "clsx";
import type { ReactNode } from "react";
import logoUrl from "./assets/assemblyai-logomark.svg";
import { ACCOUNT_MENU_ID, ACCOUNT_TOGGLE_ATTR } from "./components/account-menu.tsx";
import { DropdownPanel } from "./components/dropdown-panel.tsx";
import {
  ChevronDownIcon,
  CodeIcon,
  GearIcon,
  KeyIcon,
  PlayIcon,
  UserIcon,
} from "./components/icons.tsx";
import { CHAT_COLUMN } from "./pane-shell.tsx";
import { agentUrl } from "./platform-origin.ts";
import { SEG_GROUP, segItemClass } from "./segmented.ts";

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
 * behind a disclosure. A FAILED deploy stays expanded: the error is the
 * result, not a detail.
 *
 * This panel is the ONLY place a publish reports itself. The output used to be
 * injected into the chat as well, for the coding agent to read; nothing a
 * studio action does writes into the transcript any more, so an error here is
 * what the user has to read (and relay, if they want the agent to fix it). It
 * survives a dismissal — the mutation holds it, so re-opening shows it again.
 *
 * @see "No studio action writes into the transcript" in the package guide.
 */
export function PublishMenu(props: PublishMenuProps) {
  // The URL rather than a boolean: a `published &&` flag left the two `href`
  // and text reads narrowing `deployedSlug` by cast, which is a claim about a
  // condition three lines away rather than a fact the compiler holds.
  // Gated on `open` as well, because `agentUrl` builds a `new URL` and this
  // component stays mounted while the menu is shut.
  const publishedUrl =
    props.open && props.deployedSlug !== undefined && !props.error
      ? agentUrl(props.deployedSlug)
      : null;
  return (
    // Dismissal is Escape or a click away; the toggle exempts itself via
    // PUBLISH_TOGGLE_ATTR.
    <DropdownPanel
      id={PUBLISH_MENU_ID}
      label="Publish"
      open={props.open}
      onClose={props.onClose}
      toggleAttr={PUBLISH_TOGGLE_ATTR}
    >
      <p className="m-0 text-[13px] leading-5 text-muted">
        Ships the current workspace to production with <code className="font-mono">aai deploy</code>
        . The preview updates on its own as you edit — only this touches production. Any build or
        deploy error shows up here; third-party keys live in the Secrets pane.
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
      {publishedUrl && (
        <a
          className="rounded-md border border-line bg-cream px-2.5 py-2 font-mono text-xs break-all text-indigo hover:border-indigo-300"
          href={publishedUrl}
          target="_blank"
          rel="noreferrer"
        >
          {publishedUrl} ↗
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
    </DropdownPanel>
  );
}

/**
 * The project panes, all peers in the pane tabs, every one of them
 * offered from the moment a project exists.
 *
 * Settings joined them rather than staying a dropdown: it holds GitHub sync
 * and Delete project, which is more than a floating panel can lay
 * out. Nothing here gates on a build or a deploy —
 * Delete project has to work before anything has ever been published.
 *
 * The order is the running agent first, then the workspace and the project's
 * own configuration: UI LEADS because talking to the agent is the point of the
 * studio, Code follows as what makes it, and Secrets and Settings come last, in
 * that order: a key is something a working project needs, where Settings ends
 * in Delete project.
 *
 * **The UI tab's id is `preview` and its label is "UI".** The id names a
 * platform concept the whole product spells that way — the auto-deployed
 * PREVIEW agent, its `previewSlug`, `previewVersion` and `previewStale` — and
 * renaming the state to match a button would put a second word for one thing
 * into the codebase. The label is what the pane OFFERS: the client the project
 * serves, which is where you talk to the agent. "Preview" read as a rendering
 * of the code rather than something to use, and "Playground" said what it was
 * for without naming what it is.
 */
export type StudioTab = "preview" | "code" | "secrets" | "settings";

const TABS: { id: StudioTab; label: string; icon: () => ReactNode }[] = [
  { id: "preview", label: "UI", icon: () => <PlayIcon size={14} /> },
  { id: "code", label: "Code", icon: () => <CodeIcon size={14} /> },
  { id: "secrets", label: "Secrets", icon: () => <KeyIcon size={14} /> },
  { id: "settings", label: "Settings", icon: () => <GearIcon size={14} /> },
];

/**
 * The pane switcher. It rides in the top bar's CANVAS zone — the part of the
 * bar that starts at the canvas card's left edge (see {@link TopBar}) — so it
 * still sits directly above the pane it switches, without a toolbar row of
 * its own. Below 1100px the labels collapse to icons; they stay in the
 * accessible name and the tooltip.
 */
export function PaneTabs({
  tab,
  onSelectTab,
}: {
  tab: StudioTab;
  onSelectTab: (tab: StudioTab) => void;
}) {
  return (
    <nav aria-label="Panes" className={clsx("flex-none", SEG_GROUP)}>
      {TABS.map((entry) => (
        <button
          key={entry.id}
          type="button"
          aria-current={tab === entry.id ? "page" : undefined}
          className={clsx("seg", segItemClass(tab === entry.id))}
          title={entry.label}
          onClick={() => onSelectTab(entry.id)}
        >
          {entry.icon()}
          <span className="max-[1100px]:sr-only">{entry.label}</span>
        </button>
      ))}
    </nav>
  );
}

type TopBarProps = {
  project: string | null;
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
  /**
   * The canvas controls — the pane tabs and, over the UI pane, the preview's
   * browser chrome. Rendered in the bar's canvas zone so the canvas card needs
   * no toolbar row of its own.
   */
  children?: ReactNode;
  /** Brand click: back to the hero home (deselects the project). */
  onGoHome: () => void;
  onTogglePublish: () => void;
  onToggleAccount: () => void;
};

/** Publish's tooltip: why it is locked, what pressing it does, or where the project is live. */
function publishTooltip(props: TopBarProps, productionUrl: string | null): string | undefined {
  if (!props.hasBuild) return "Publish unlocks after your first build";
  if (props.chatBusy) return PUBLISH_WAIT_FOR_TURN;
  if (props.publishOpen) return "Hide the publish menu";
  if (productionUrl) return `Live at ${productionUrl}`;
  return undefined;
}

/**
 * The shared top bar. With a project open it is ONE row split at the chat
 * column: the left zone is exactly the chat column's width (`CHAT_COLUMN`, the
 * same 392px `ChatPanel` takes), so the project name sits over the
 * conversation and everything from the pane tabs on starts at the canvas
 * card's left edge. That split is what lets the canvas drop its own toolbar —
 * the controls are still directly above the pane they drive, and the pane's
 * content starts 48px higher.
 *
 * Inside a project the brand is the logo alone (it still goes home); the
 * wordmark is for the home screen, where the bar has nothing else to say.
 */
export function TopBar(props: TopBarProps) {
  // Once per render: the title and the dot both read it, and `agentUrl`
  // builds a `new URL` each time it is asked.
  const productionUrl = props.deployedSlug ? agentUrl(props.deployedSlug) : null;
  const publishTitle = publishTooltip(props, productionUrl);
  return (
    <header className="flex h-[52px] flex-none items-center border-b border-line bg-panel px-4">
      <div
        className={clsx(
          "flex min-w-0 items-center gap-2",
          props.project ? `${CHAT_COLUMN} flex-none pr-2` : "flex-1",
        )}
      >
        <button
          type="button"
          className="-ml-1.5 flex flex-none cursor-pointer items-center gap-2 rounded-md border-none bg-transparent px-1.5 py-1 hover:bg-cream"
          onClick={props.onGoHome}
          title="Home"
        >
          <img src={logoUrl} alt="AssemblyAI" className="h-5 w-5" />
          {/* The wordmark is home-screen only: inside a project the logo
              identifies the app, and the bar's room goes to the project. */}
          {!props.project && (
            <span className="hidden font-serif text-[16px] whitespace-nowrap text-fg md:inline">
              AssemblyAI Build
            </span>
          )}
        </button>
        {props.project && (
          <>
            <span className="flex-none text-[18px] font-light text-line-strong" aria-hidden>
              /
            </span>
            <span
              className="min-w-0 truncate text-[13px] font-medium text-fg"
              title={props.project}
            >
              {props.project}
            </span>
          </>
        )}
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-3 pl-2">
        {props.children}
        <div className="flex-1" />
        {/* Publish is project-scoped: the home screen has nothing to ship.
            A project that is LIVE says so on the button itself (the dot); the
            production address is in the menu it opens. */}
        {props.project && (
          <button
            type="button"
            {...{ [PUBLISH_TOGGLE_ATTR]: "" }}
            className={clsx(
              "btn btn-primary h-8 flex-none pr-2.5",
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
            {productionUrl && (
              <span
                data-live
                aria-hidden
                className="h-[7px] w-[7px] flex-none rounded-full bg-emerald-300 ring-2 ring-white/20"
              />
            )}
            Publish
            <span aria-hidden className={clsx("flex", props.publishOpen && "rotate-180")}>
              <ChevronDownIcon />
            </span>
          </button>
        )}
        {/* Account-scoped, so it sits outside the project panes and is here on
            the home screen too — where the API key would otherwise be
            unreachable. Log out lives in the panel it opens. */}
        <button
          type="button"
          {...{ [ACCOUNT_TOGGLE_ATTR]: "" }}
          aria-label="Account"
          className={clsx(
            "flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded-full border border-line bg-cream p-0 text-muted hover:border-line-strong hover:text-fg",
            props.accountOpen && "border-fg text-fg",
          )}
          onClick={props.onToggleAccount}
          title="Account"
          aria-haspopup="dialog"
          aria-expanded={props.accountOpen ?? false}
          aria-controls={props.accountOpen ? ACCOUNT_MENU_ID : undefined}
        >
          <UserIcon size={15} />
        </button>
      </div>
    </header>
  );
}
