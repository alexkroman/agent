import "@alexkroman1/aai-ui/styles.css";
import { AutoScroll, mountClient, useAgentState, useEvent } from "@alexkroman1/aai-ui";
import { useState } from "react";
import {
  hiringProjection,
  MAX_FEEDBACK_ROUNDS,
  SCREENING_PROGRESS,
  type ScreeningProgress,
} from "./shared.ts";

/**
 * The leaderboard, the feedback trail, and the drafts.
 *
 * A ranking of twelve is the one thing in this template nobody can hold by
 * ear: the caller is read three names and asks about a fourth. The sidebar
 * shows the whole table the evaluator produced, which round of feedback it
 * came from, and — once the coordinator has run — a subject line per draft
 * with whether it invites or declines. Their flow printed the top three and
 * wrote thirty files; this is both, on one screen, while the call goes on.
 *
 * **Both mechanisms are on this one screen, which is the other thing it
 * teaches.** The ranking is STATE — a reload should show it again — so it rides
 * a slot through `useAgentState`. The ticker below is a MOMENT: re-rendering
 * "scoring seven of twelve" after a reload would describe a fan-out that
 * finished long ago, so it is a `ctx.send` read by `useEvent` and it lives in a
 * `useState` that a reconnect empties.
 */

function HiringSidebar() {
  const view = useAgentState(hiringProjection);

  if (view.leaderboard.length === 0 && view.unscored.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <span className="text-4xl">🗂️</span>
        <p className="text-sm opacity-60 text-aai-text">
          Confirm the role and the ranking appears here once the applicants are scored.
        </p>
        <ScreeningTicker />
      </div>
    );
  }

  const invited = view.drafts.filter((draft) => draft.proceed).length;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4 text-aai-text">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-bold uppercase tracking-wide opacity-60">Screening</h3>
        <p className="text-sm">{view.jobTitle}</p>
        <p className="text-xs opacity-50">
          {view.leaderboard.length} scored · feedback round {view.rounds} of {MAX_FEEDBACK_ROUNDS}
          {view.drafts.length > 0 &&
            ` · ${invited} invited, ${view.drafts.length - invited} declined`}
        </p>
        <ScreeningTicker />
      </div>

      <AutoScroll
        scrollClassName="min-h-0 overflow-y-auto"
        contentClassName="flex flex-col gap-2 pr-1"
      >
        {view.leaderboard.map((row) => (
          <div
            key={row.id}
            className={`rounded-lg p-3 bg-aai-surface${row.shortlisted ? " border border-aai-primary" : ""}`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm">
                <span className="opacity-50">{row.rank}.</span> {row.name}
                {row.shortlisted && <span className="ml-2 text-xs text-aai-primary">invited</span>}
              </p>
              <span className="text-sm font-bold tabular-nums">{row.score}</span>
            </div>
            <div className="mt-1 h-1 w-full rounded-full bg-aai-border">
              {/* The WIDTH is the one thing here that is genuinely computed, so it
                  stays inline; the colour is a token. */}
              <div
                className="h-1 rounded-full transition-all bg-aai-primary"
                style={{ width: `${row.score}%` }}
              />
            </div>
            <p className="mt-1 text-xs opacity-70">{row.reason}</p>
          </div>
        ))}
        {view.unscored.length > 0 && (
          <p className="text-xs opacity-50">Not scored this round: {view.unscored.join(", ")}</p>
        )}
      </AutoScroll>

      {view.drafts.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-[11px] font-bold uppercase tracking-wide opacity-60">Drafts</h3>
          {view.drafts.map((draft) => (
            <p key={draft.candidateId} className="text-xs">
              <span className={draft.proceed ? "text-aai-primary" : "opacity-50"}>
                {draft.proceed ? "invite" : "decline"}
              </span>{" "}
              {draft.name} — <span className="opacity-70">{draft.subject}</span>
              {!draft.accepted && <span className="ml-1 opacity-50">(needs a look)</span>}
            </p>
          ))}
        </div>
      )}

      {view.feedback.length > 0 && (
        <details className="text-xs opacity-60">
          <summary className="cursor-pointer">Feedback applied ({view.feedback.length})</summary>
          <div className="mt-1 flex flex-col gap-1">
            {view.feedback.map((entry, index) => (
              // Append-only and capped, so the index is stable for its lifetime.
              <p key={`${index}-${entry}`}>
                {index + 1}. {entry}
              </p>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/** The wait, while twelve model calls run: the last tick of a fan-out that has
 *  not reached its total yet, and nothing once it has. */
function ScreeningTicker() {
  const [progress, setProgress] = useState<ScreeningProgress | null>(null);
  useEvent<ScreeningProgress>(SCREENING_PROGRESS, setProgress);
  if (!progress || progress.done >= progress.total) return null;
  const verb = progress.phase === "scoring" ? "Scoring" : "Writing";
  return (
    <p className="text-xs opacity-60 text-aai-text">
      {verb} {progress.done} of {progress.total}…
    </p>
  );
}

mountClient({
  name: "Hiring Desk",
  sidebar: HiringSidebar,
  theme: {
    bg: "#0f1412",
    primary: "#5ec48f",
    text: "#eef3ef",
    surface: "#1a221e",
    border: "#27332d",
  },
  tools: {
    screen_candidates: { icon: "\u{1F4CB}", label: "Scoring the applicants" },
    rescore_with_feedback: { icon: "\u{1F501}", label: "Scoring again with feedback" },
    proceed_to_emails: { icon: "\u{2709}", label: "Writing the emails" },
    candidate_details: { icon: "\u{1F464}", label: "Looking up an applicant" },
    read_email: { icon: "\u{1F4E8}", label: "Reading a draft" },
    screening_status: { icon: "\u{2139}", label: "Checking where things stand" },
  },
});
