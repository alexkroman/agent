// Copyright 2026 the AAI authors. MIT license.
// The studio's shared 60px top bar (brand, project name, the pane segmented
// control, Publish, Account, Log out) and the Publish dropdown it opens.
// Split from app.tsx, which owns all the state these render. Project
// switching lives in the home sidebar (brand → home), not here.
//
// The switcher was "the seven panes" and is six or eight now: Workflows and
// Database are both offered only once the project has opted into a database
// (`isTabVisible`).

import clsx from "clsx";
import { useRef } from "react";
import { ACCOUNT_MENU_ID, ACCOUNT_TOGGLE_ATTR } from "./account-menu.tsx";
import logoUrl from "./assets/assemblyai-logomark.svg";
import { useDismissablePanel } from "./dismissable.ts";
import { agentUrl } from "./platform-origin.ts";

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
  const panel = useRef<HTMLDivElement>(null);
  const { open, onClose } = props;

  // With Close gone, dismissal is Escape or a click away from the panel.
  // The toggle exempts itself (see PUBLISH_TOGGLE_ATTR).
  useDismissablePanel({ open, onClose, panel, toggleAttr: PUBLISH_TOGGLE_ATTR });

  if (!open) return null;
  // The URL rather than a boolean: a `published &&` flag left the two `href`
  // and text reads narrowing `deployedSlug` by cast, which is a claim about a
  // condition three lines away rather than a fact the compiler holds.
  const publishedUrl =
    props.deployedSlug !== undefined && !props.error ? agentUrl(props.deployedSlug) : null;
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
        . The preview updates on its own as you edit — only this touches production. Any build or
        deploy error shows up here; third-party keys live under Secrets.
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
          className="font-mono text-xs break-all text-indigo"
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
    </div>
  );
}

/**
 * The project panes, all peers in the segmented control. Every one of them is
 * offered from the moment a project exists EXCEPT `workflows` and `database`,
 * which the project has to opt into — see {@link isTabVisible}.
 *
 * Settings joined them rather than staying a dropdown: it holds the CLI
 * round-trip, the Database switch and Delete project, which is more than a
 * floating panel can lay out. Nothing here gates on a build or a deploy —
 * Delete project has to work before anything has ever been published, and the
 * API pane says what the agent will answer once something is.
 *
 * The order is the deployed agent first (call it, talk to it, watch what it is
 * still doing, read what it stored), then the workspace and the project's own
 * configuration: API LEADS, and UI sits beside it because the two ask one
 * question — "what does this thing do?" — of a caller and of a person
 * respectively, so the contract comes before the client that exercises it.
 * Workflows follows them because a run is that API's output outliving the
 * request that made it; and Database is the same again one step further out,
 * the rows still there when every run has finished. Secrets and Settings come
 * last, in that order: a key is something a working project needs, where
 * Settings ends in Delete project.
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
export type StudioTab =
  | "docs"
  | "preview"
  | "workflows"
  | "database"
  | "code"
  | "logs"
  | "secrets"
  | "settings";

// Logs sits directly after Code, which is where its use is: you write
// something, you run it, you read what it printed.
const TABS: { id: StudioTab; label: string }[] = [
  { id: "docs", label: "API" },
  { id: "preview", label: "UI" },
  { id: "workflows", label: "Workflows" },
  { id: "database", label: "Database" },
  { id: "code", label: "Code" },
  { id: "logs", label: "Logs" },
  { id: "secrets", label: "Secrets" },
  { id: "settings", label: "Settings" },
];

/**
 * What a pane can be gated on. One entry today — it gates two panes, but on the
 * same fact — and it is the only gate in the switcher: everything else here is
 * reachable from the moment a project exists (Settings holds Delete project,
 * Secrets holds the key the first build needs), so a second gate is a claim
 * about the switcher's invariant and not a flag.
 */
export type TabGates = {
  /** The project opted into a database — see `ProjectData.databaseEnabled`. */
  databaseEnabled: boolean;
};

/**
 * Whether a pane is offered at all.
 *
 * **Database and Workflows are the panes a project can lack, and one opt-in
 * decides both.** A database is taken in Settings (studio-database.ts), and
 * until it is taken the Database pane could only ever show an empty table list
 * — a tab that answers no question reads as a broken feature rather than as an
 * unused one, and it invited the question "where is my data" from users who had
 * never turned anything on. So the switch reveals the pane rather than merely
 * un-erroring it.
 *
 * Workflows rides on the same flag because a run is only DURABLE when there is
 * a database behind it: `configureWorkflowWorld` picks the Postgres world off
 * the app's `DATABASE_URL`, and without one a guest gets the local world, whose
 * queue is in memory and whose data directory is per-process under `tmpdir()`
 * (see `aai/host/workflow-world.ts`). A pane whose subtitle promises runs that
 * "keep going after the call, the page, or the request that began them" would
 * then be listing runs that die with the sandbox — which is a worse answer than
 * no tab, because it looks like the feature working.
 *
 * Exported because TWO callers need one answer: the switcher, which decides
 * what to render, and `project-view.tsx`, which has to decide what a SELECTION
 * of a now-hidden pane means. Those disagreeing is a tab bar with no
 * `aria-current` beside a blank pane — so the predicate is shared rather than
 * spelled twice.
 */
export function isTabVisible(tab: StudioTab, gates: TabGates): boolean {
  return tab === "database" || tab === "workflows" ? gates.databaseEnabled : true;
}

type TopBarProps = {
  project: string | null;
  tab: StudioTab;
  deployedSlug?: string | undefined;
  hasBuild: boolean;
  /**
   * The project opted into a database, which is what puts the **Workflows** and
   * **Database** tabs in the switcher at all (see {@link isTabVisible}).
   * Required rather than defaulted: the default is "no tab", and a caller that
   * forgets to thread it would silently hide two panes the project paid for.
   */
  databaseEnabled: boolean;
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
  // Once per render: the href, the title and the link text are the same URL,
  // and `agentUrl` builds a `new URL` each time it is asked.
  const productionUrl = props.deployedSlug ? agentUrl(props.deployedSlug) : null;
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
          {/* `i` indexes the VISIBLE list, so the left border still falls
              between neighbours when a pane is missing — indexing TABS would
              leave a seam where the gated tabs used to be. */}
          {TABS.filter((entry) => isTabVisible(entry.id, props)).map((entry, i) => (
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
      {productionUrl && (
        <a
          // `min-w-0`: a flex item defaults to min-width:auto, so `truncate`
          // alone could not shrink it and the action buttons overflowed the
          // viewport instead (measured: 829px of bar in a 768px window).
          className="max-w-80 min-w-0 truncate font-mono text-xs whitespace-nowrap text-muted hover:text-indigo"
          href={productionUrl}
          target="_blank"
          rel="noreferrer"
          title={`Production: ${productionUrl}`}
        >
          {productionUrl} ↗
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
