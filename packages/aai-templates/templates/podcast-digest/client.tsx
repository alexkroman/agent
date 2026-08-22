// Copyright 2026 the AAI authors. MIT license.
/**
 * The browser half — a form that starts a run, and a panel that watches one
 * that may outlive the browser by a week.
 *
 * Mounted with `page()` rather than `client()`: there is no session to build, so
 * no socket, no audio graph, no microphone request. `createWorkflowApi()` starts
 * a run, `useWorkflowRun()` watches its STATUS, `useWorkflowProgress()` reads
 * what it has WRITTEN. The API is durable, so the `runId` is the whole state —
 * it survives a reload, another device, or `curl`.
 *
 * ## What a SCHEDULED run adds to `link-digest`'s page
 *
 * Two controls that only make sense when a run spends most of its life asleep,
 * and both are the point of copying this file rather than that one:
 *
 * - **Wake.** A sleeping run's next digest is hours or days out.
 *   `api.wake(runId)` cuts the wait short and sends it now. Without it the only
 *   handle on a sleeping run is `cancel`, so "send it now" and "throw it away"
 *   would be the same button. `wake` answering 0 means the run had already moved
 *   past its sleep, which is why nothing here treats that as a failure.
 * - **Cancel.** A run scheduled for thirty digests is a standing commitment, and
 *   the page that started it is the obvious place to end it. Cancelling is why
 *   `daysToRun` can be generous.
 *
 * ## Why the status panel reads `digestsSent` and not a progress bar
 *
 * There is nothing to fill. A run posts digest 3 of 7 and then sleeps for a day
 * — a bar would sit at 43% looking stalled for most of the run's life. The
 * honest display is the count plus the run's own newest line.
 */

import { createWorkflowApi, page, useWorkflowProgress, useWorkflowRun } from "@alexkroman1/aai-ui";
import "@alexkroman1/aai-ui/styles.css";
// The one runtime import from the SDK a browser bundle wants: `/utils` is the
// zod-free subpath, so it costs a few hundred bytes rather than the root
// barrel's module graph.
import { errorMessage } from "@alexkroman1/aai/utils";
// ERASED at build time, so naming the agent's own type costs the browser bundle
// nothing — and it is what stops this file restating a shape `workflows/
// digest.ts` already declares.
import type { WorkflowOutputOf } from "@alexkroman1/aai/workflow-api";
import { useState } from "react";
import type { dailyDigest } from "./agent.ts";

/** What a completed run reports, derived from the workflow rather than restated. */
type Digest = WorkflowOutputOf<typeof dailyDigest>;

/**
 * Hoisted out of the component deliberately.
 *
 * `useWorkflowRun` holds the client in a ref precisely so a fresh object per
 * render cannot restart its watch, but building one in render is still a new
 * `fetch` closure every time and reads as though it were free.
 */
const api = createWorkflowApi();

/** The defaults the schema declares, restated once so the form starts valid. */
const DEFAULTS = {
  slackWorkflowTextParam: "text",
  maxEpisodesPerDigest: 5,
  intervalEvery: 1,
  intervalUnit: "days",
  daysToRun: 7,
} as const;

export function App() {
  const [podcastChannels, setPodcastChannels] = useState("");
  const [slackWebhookUrl, setSlackWebhookUrl] = useState("");
  const [textParam, setTextParam] = useState<string>(DEFAULTS.slackWorkflowTextParam);
  const [maxEpisodes, setMaxEpisodes] = useState<number>(DEFAULTS.maxEpisodesPerDigest);
  const [every, setEvery] = useState<number>(DEFAULTS.intervalEvery);
  const [unit, setUnit] = useState<"minutes" | "hours" | "days">(DEFAULTS.intervalUnit);
  const [daysToRun, setDaysToRun] = useState<number>(DEFAULTS.daysToRun);
  const [runId, setRunId] = useState<string>();
  const [error, setError] = useState<string>();
  // The generic is what makes `run.status === "completed"` narrow to a TYPED
  // `run.output` instead of `unknown`.
  const { run, polling } = useWorkflowRun<Digest>(runId, { api });
  // What the run has SAID, as against where it has got to. Defaults to `string`,
  // which is what `report()` writes.
  const { latest, supported } = useWorkflowProgress(runId, { api });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(undefined);
    try {
      // Resolves as soon as the run EXISTS — deliberately not when it finishes,
      // which here could be a month away.
      setRunId(
        await api.start("dailyDigest", {
          podcastChannels,
          slackWebhookUrl,
          slackWorkflowTextParam: textParam,
          maxEpisodesPerDigest: maxEpisodes,
          intervalEvery: every,
          intervalUnit: unit,
          daysToRun,
        }),
      );
    } catch (err) {
      // The agent's own sentence: an input failing the workflow's schema names
      // the issue, which is better copy than anything this page could write.
      setError(errorMessage(err));
    }
  };

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <h1 className="text-2xl font-medium">Podcast Digest</h1>

      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          Podcast links
          <textarea
            required
            rows={3}
            value={podcastChannels}
            onChange={(e) => setPodcastChannels(e.target.value)}
            placeholder="https://podcasts.apple.com/us/podcast/id1234, https://example.com/feed.xml"
            className="rounded-md border px-3 py-2"
          />
          <span className="text-sm opacity-70">
            Apple Podcasts, Spotify, an RSS feed, or a show page — comma-separated.
          </span>
        </label>

        <label className="flex flex-col gap-1">
          Slack webhook URL
          <input
            type="url"
            required
            value={slackWebhookUrl}
            onChange={(e) => setSlackWebhookUrl(e.target.value)}
            placeholder="https://hooks.slack.com/services/…"
            className="rounded-md border px-3 py-2"
          />
          <span className="text-sm opacity-70">
            An incoming webhook (<code>/services/…</code>) or a workflow trigger (
            <code>/triggers/…</code>).
          </span>
        </label>

        {/* Only a trigger URL reads this, so it hides for the common case
            rather than asking everyone about a Slack concept most never meet. */}
        {slackWebhookUrl.includes("/triggers/") && (
          <label className="flex flex-col gap-1">
            Slack workflow variable
            <input
              type="text"
              required
              pattern="[A-Za-z_][A-Za-z0-9_]*"
              value={textParam}
              onChange={(e) => setTextParam(e.target.value)}
              className="rounded-md border px-3 py-2"
            />
            <span className="text-sm opacity-70">
              Must match a variable the Slack workflow declares.
            </span>
          </label>
        )}

        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1">
            Episodes per digest
            <input
              type="number"
              min={1}
              max={20}
              value={maxEpisodes}
              onChange={(e) => setMaxEpisodes(e.target.valueAsNumber)}
              className="w-28 rounded-md border px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1">
            Repeat every
            <input
              type="number"
              min={1}
              max={365}
              value={every}
              onChange={(e) => setEvery(e.target.valueAsNumber)}
              className="w-28 rounded-md border px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1">
            Unit
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value as "minutes" | "hours" | "days")}
              className="rounded-md border px-3 py-2"
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Digests to post
            <input
              type="number"
              min={1}
              max={30}
              value={daysToRun}
              onChange={(e) => setDaysToRun(e.target.valueAsNumber)}
              className="w-28 rounded-md border px-3 py-2"
            />
          </label>
        </div>

        <button type="submit" disabled={polling} className="self-start rounded-md border px-4 py-2">
          {polling ? "Digest scheduled" : "Start digest"}
        </button>
      </form>

      {error !== undefined && <p className="text-red-600">{error}</p>}

      {/* A run that has not settled says so. `polling` is not derivable from the
          snapshot alone — an id the agent never knew leaves `run` undefined,
          which would otherwise read as "still waiting" forever. */}
      {polling && <p>You can close this tab — the run continues without it.</p>}

      {/* The run's own narration, newest line only.

          `supported` is what keeps this from being blank forever on an agent
          deployed before progress streams existed: "wrote nothing yet" and
          "serves no stream" are indistinguishable from `progress` alone. */}
      {supported && latest !== undefined && <p className="text-sm opacity-70">{latest}</p>}

      {runId !== undefined && polling && (
        <div className="flex gap-2">
          {/* The counterpart of the `sleep` in `workflows/digest.ts` — see the
              module doc on why a scheduled run needs this AND cancel. */}
          <button
            type="button"
            onClick={() => void api.wake(runId)}
            className="rounded-md border px-3 py-1 text-sm"
          >
            Send the next digest now
          </button>
          <button
            type="button"
            onClick={() => void api.cancel(runId).catch((err) => setError(errorMessage(err)))}
            className="rounded-md border px-3 py-1 text-sm text-red-600"
          >
            Stop the schedule
          </button>
        </div>
      )}

      {run?.status === "failed" && <p className="text-red-600">That run failed: {run.error}</p>}
      {run?.status === "cancelled" && <p>Cancelled — no further digests will be posted.</p>}

      {run?.status === "completed" && (
        <article className="flex flex-col gap-4">
          <p className="text-sm opacity-70">
            Posted {run.output.digestsSent} of {run.output.digestsScheduled} digests to{" "}
            {run.output.deliveryTarget}, every {run.output.scheduleInterval}.
          </p>
          {run.output.lastDigest?.episodes.map((episode) => (
            <section key={episode.id} className="flex flex-col gap-1 border-t pt-3">
              <p className="text-sm opacity-70">{episode.podcastTitle}</p>
              <h2 className="text-lg">
                <a href={episode.url} className="underline">
                  {episode.title}
                </a>
              </h2>
              <p>{episode.summary}</p>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
                {episode.keyPoints.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </section>
          ))}
        </article>
      )}
    </main>
  );
}

page({ name: "Podcast Digest", component: App });
