// Copyright 2026 the AAI authors. MIT license.
// An EVAL for a WORKFLOW APP: does the run actually do the work? Run it with
// `aai eval`.
//
// `agent.test.ts` asserts about the declaration, drives each step on its own,
// and covers the feed scraping and the Slack rendering as pure functions. This
// drives the WHOLE BODY — `dailyDigestFlow` from the top — and what it is here
// to check is the one thing no per-step spec can see: that **the run is the
// schedule**. There is no cron in this template. A durable `sleep()` between
// digests IS the scheduler, so "does it post three digests two hours apart"
// is a question about the BODY's loop and about nothing else.
//
// EVERY CASE HERE IS SCRIPTED IN BOTH MODES, which is unusual and deliberate.
// Two reasons, and neither is convenience:
//
//   * **Every leg of this run is HTTP through one slot.** The feeds, the two
//     transcription calls, the model and the Slack post all go through
//     `stepFetch`, and publishing a fake REPLACES — so there is no arrangement
//     in which some legs are real and the Slack post is not. A live run would
//     have to POST a summarized digest to a real Slack workspace, which a
//     template eval may not do.
//   * **The claims are arithmetic.** How many sleeps a run of three digests
//     asks for, which episode was polled how many times, what a digest says
//     about an episode nobody could transcribe — a live provider can neither
//     confirm nor deny any of them. It can only be asked and then have its
//     answer accepted, which is not evidence.
//
// So a LIVE run of this file makes no provider call and costs nothing. That is
// the honest report rather than a gap being papered over: what a live run would
// add here is a real transcript, and `spoken-summary` and `call-audit` both
// measure that against a real recording already.
//
// WHAT NO EVAL HERE COVERS: durability — which for THIS template is most of
// what it is for. Imported through vitest with no bundler in the path, a
// `"use workflow"` body is an ordinary async function, so the multi-day
// suspension that makes a digest arrive tomorrow is not exercised; the sleep is
// RECORDED and skipped. `run.slept` below is that admission written as an
// assertion, and it is the only way to check a seven-day schedule without
// waiting a week. `aai-cli`'s `dev-workflow.scenario.test.ts` is the tier that
// really suspends and resumes a run.
import { TRANSCRIBE_API } from "@alexkroman1/aai/step";
import { installStubStepFetch } from "@alexkroman1/aai/testing/vitest";
import { describeWorkflowEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import agentDef, { dailyDigest } from "./agent.ts";
import { MAX_POLL_ATTEMPTS, POLL_DELAY, scheduleIntervalMs } from "./workflows/digest.ts";

/** The feed every case reads. Not a real host — nothing here leaves the process. */
const FEED_URL = "https://feeds.example.test/rebuild.xml";

/** A classic incoming webhook, which takes Block Kit. */
const SLACK_WEBHOOK = "https://hooks.slack.com/services/T00000000/B00000000/eval";

/**
 * The three episodes, newest first — and each transcript carries a SENTINEL
 * word nothing else in the run produces.
 *
 * That is what makes "the right transcript reached the right episode" an
 * assertion rather than a hope: the scripted model echoes whichever sentinel it
 * was shown, so a batch that crossed two episodes' transcripts shows up as the
 * wrong word in the wrong digest entry. With N jobs in flight finishing out of
 * order, that is exactly the mistake worth catching.
 */
const EPISODES = [
  {
    title: "The migration nobody owns",
    audioUrl: "https://cdn.example.test/rebuild-13.mp3",
    published: "Wed, 13 Aug 2026 09:00:00 GMT",
    sentinel: "quokka",
  },
  {
    title: "Cutting the release train in half",
    audioUrl: "https://cdn.example.test/rebuild-12.mp3",
    published: "Tue, 12 Aug 2026 09:00:00 GMT",
    sentinel: "narwhal",
  },
  {
    title: "Hiring for the platform team",
    audioUrl: "https://cdn.example.test/rebuild-11.mp3",
    published: "Mon, 11 Aug 2026 09:00:00 GMT",
    sentinel: "pangolin",
  },
] as const;

/** A podcast RSS document: an `<rss>` root and an `<enclosure url=>` per item. */
const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>The Rebuild</title>
${EPISODES.map(
  (episode) => `<item>
  <title>${episode.title}</title>
  <link>https://example.test/${episode.sentinel}</link>
  <guid isPermaLink="false">${episode.sentinel}</guid>
  <pubDate>${episode.published}</pubDate>
  <enclosure url="${episode.audioUrl}" type="audio/mpeg" length="1234"/>
</item>`,
).join("\n")}
</channel></rss>`;

/** How one episode's transcription behaves. */
type EpisodeScript = {
  /** Polls that answer "still working" before this job completes. Defaults to 0. */
  pendingPolls?: number;
  /** Refuse the SUBMIT with this status instead. A 4xx is terminal. */
  submitStatus?: number;
};

/**
 * Answer the whole world in memory: the feed, the two transcription calls, the
 * model, and Slack.
 *
 * ONE handler, because publishing a `stepFetch` REPLACES — and this run has
 * four different far sides, so routing by URL is the only shape available.
 *
 * **The transcription legs are hand-routed here rather than handed to
 * `installStubTranscribe`, and that is a gap rather than a preference.** That
 * fake counts `pendingPolls` GLOBALLY and stages a `failure` per LEG, so
 * neither "these two episodes finish on different rounds" nor "this ONE episode
 * is broken" is expressible through it — and both are this template's subject,
 * it being the only one that has a BATCH of jobs in flight. The URLs are built
 * from the SDK's own `TRANSCRIBE_API` constant, so a case still cannot pass
 * because the fake and the step agree on a typo.
 */
function scriptWorld(
  scripts: Readonly<Record<string, EpisodeScript>> = {},
  slack: { status?: number; body?: unknown } = {},
) {
  /** Minted job id → the audio URL it was submitted for. */
  const jobs = new Map<string, string>();
  /** Job id → polls answered so far. */
  const polls = new Map<string, number>();
  let minted = 0;

  return installStubStepFetch((request) => {
    if (request.url === FEED_URL) return { body: FEED_XML };

    if (request.url === `${TRANSCRIBE_API}/v2/transcript` && request.method === "POST") {
      const audioUrl = String(
        (JSON.parse(String(request.body ?? "{}")) as { audio_url?: string }).audio_url,
      );
      const script = scripts[audioUrl] ?? {};
      if (script.submitStatus !== undefined) {
        return { status: script.submitStatus, body: { error: `no audio at ${audioUrl}` } };
      }
      minted += 1;
      const id = `job_${minted}`;
      jobs.set(id, audioUrl);
      return { body: { id } };
    }

    if (request.url.startsWith(`${TRANSCRIBE_API}/v2/transcript/`)) {
      const id = request.url.slice(request.url.lastIndexOf("/") + 1);
      const seen = polls.get(id) ?? 0;
      polls.set(id, seen + 1);
      const audioUrl = jobs.get(id) ?? "";
      if (seen < (scripts[audioUrl]?.pendingPolls ?? 0)) return { body: { status: "processing" } };
      const episode = EPISODES.find((one) => one.audioUrl === audioUrl);
      return {
        body: {
          status: "completed",
          text: `The hosts spent the whole hour on the ${episode?.sentinel ?? "unknown"}.`,
          audio_duration: 1800,
        },
      };
    }

    if (request.url.includes("/chat/completions")) {
      // The reply ECHOES whichever sentinel the prompt carried, which is what
      // makes the transcript→episode correlation assertable end to end.
      const prompt = String(request.body ?? "");
      const seen = EPISODES.find((one) => prompt.includes(one.sentinel))?.sentinel ?? "nothing";
      return {
        body: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: `An hour about the ${seen}.`,
                  keyPoints: [`The ${seen} is the decision`, "Nobody owns the follow-up"],
                }),
              },
            },
          ],
        },
      };
    }

    if (request.url.startsWith("https://hooks.slack.com/")) {
      return { status: slack.status ?? 200, body: slack.body ?? "ok" };
    }

    return { status: 404, body: { error: `no route for ${request.method} ${request.url}` } };
  });
}

/** The bodies of every Slack post the run made, parsed. */
function slackPosts(world: ReturnType<typeof scriptWorld>): Record<string, unknown>[] {
  return world.calls
    .filter((call) => call.url.startsWith("https://hooks.slack.com/"))
    .map((call) => JSON.parse(String(call.body ?? "{}")) as Record<string, unknown>);
}

/** How many times the job for `audioUrl` was polled. */
function pollsFor(world: ReturnType<typeof scriptWorld>, audioUrl: string): number {
  const submitted = world.calls.filter(
    (call) => call.url === `${TRANSCRIBE_API}/v2/transcript` && call.method === "POST",
  );
  const at = submitted.findIndex((call) => String(call.body ?? "").includes(audioUrl));
  if (at < 0) return 0;
  return world.calls.filter((call) => call.url.endsWith(`/v2/transcript/job_${at + 1}`)).length;
}

/** The whole input, with only the fields a case cares about spelled out. */
function input(overrides: Partial<Parameters<typeof dailyDigest.run>[0]> = {}) {
  return {
    podcastChannels: FEED_URL,
    slackWebhookUrl: SLACK_WEBHOOK,
    slackWorkflowTextParam: "text",
    maxEpisodesPerDigest: 2,
    intervalEvery: 1,
    intervalUnit: "days" as const,
    daysToRun: 1,
    ...overrides,
  };
}

describeWorkflowEval(agentDef, (test) => {
  test("the RUN is the schedule: N digests, N-1 recorded sleeps, no cron", async ({ app }) => {
    // The case this template exists for. Three digests two hours apart is
    // ordinarily six hours of wall clock; here the durable waits are RECORDED
    // rather than taken, which is the only way to assert a schedule at all.
    const world = scriptWorld();

    const run = await app.run(
      dailyDigest,
      input({ daysToRun: 3, intervalEvery: 2, intervalUnit: "hours" }),
    );

    // The error FIRST, so a failed run names its own reason instead of
    // reporting "expected 'failed' to be 'completed'".
    expect(run.error).toBeUndefined();
    expect(run.status).toBe("completed");
    const output = run.output;
    if (output === undefined) expect.fail("a completed run must carry an output");

    // THE INVARIANT: one sleep BETWEEN digests and none after the last, because
    // a run that has delivered everything it owes should end rather than sleep
    // for two hours and then end.
    const interval = scheduleIntervalMs(2, "hours");
    expect(run.slept).toEqual([{ duration: interval }, { duration: interval }]);
    expect(run.slept).toHaveLength(output.digestsScheduled - 1);
    // And no poll waits are mixed in: every job finished on its first poll, so
    // every recorded sleep above is a SCHEDULE sleep.
    expect(run.slept.every((one) => one.duration === interval)).toBe(true);

    expect(output.digestsScheduled).toBe(3);
    expect(output.digestsSent).toBe(3);
    expect(output.scheduleInterval).toBe("2 hours");
    expect(output.deliveryTarget).toBe("Slack webhook");

    // Three posts, numbered, each a Block Kit payload with the notification
    // line an incoming webhook needs.
    const posts = slackPosts(world);
    expect(posts).toHaveLength(3);
    expect(posts.map((post) => post.text)).toEqual([
      "Podcast digest 1/3: 2 episode summaries",
      "Podcast digest 2/3: 2 episode summaries",
      "Podcast digest 3/3: 2 episode summaries",
    ]);
    for (const post of posts) expect(Array.isArray(post.blocks)).toBe(true);

    // The last digest is what the page renders, and its clock came from a STEP
    // — a `new Date()` in the body would answer differently on every replay.
    expect(output.lastDigest?.slackStatus).toBe("ok");
    expect(Number.isFinite(Date.parse(output.lastDigest?.sentAt ?? ""))).toBe(true);
    // Two episodes, newest first, and each carrying ITS OWN transcript.
    expect(output.lastDigest?.episodes.map((one) => one.title)).toEqual([
      EPISODES[0].title,
      EPISODES[1].title,
    ]);
    expect(output.lastDigest?.episodes[0]?.summary).toContain(EPISODES[0].sentinel);
    expect(output.lastDigest?.episodes[1]?.summary).toContain(EPISODES[1].sentinel);

    // The feed is re-read once per digest, which is what makes a repeating run
    // pick up what is NEW rather than re-posting yesterday's list.
    expect(world.calls.filter((call) => call.url === FEED_URL)).toHaveLength(3);
    expect(run.reported.filter((line) => line === "Finding recent podcast episodes.")).toHaveLength(
      3,
    );
  });

  test("a finished episode is never polled again, so the slow one holds nothing up", async ({
    app,
  }) => {
    // The batch poll loop, which is this template's one genuinely new mechanism:
    // N episodes in flight finish out of ORDER, so `pending` has to SHRINK. A
    // loop that waited for all N every round would poll the finished episode
    // four times too — cheap here and, with `maxEpisodesPerDigest` up to 20 and
    // a twenty-second wait per round, the difference between a digest arriving
    // and a digest timing out.
    //
    // The NEWEST episode is the slow one deliberately: it makes completion
    // order and publication order disagree, which is the other half of what
    // this case pins.
    const world = scriptWorld({
      [EPISODES[0].audioUrl]: { pendingPolls: 3 },
      [EPISODES[1].audioUrl]: { pendingPolls: 0 },
    });

    const run = await app.run(dailyDigest, input());

    expect(run.error).toBeUndefined();
    const output = run.output;
    if (output === undefined) expect.fail("a completed run must carry an output");

    // The fast episode was polled ONCE and then dropped out of `pending`; the
    // slow one took four rounds. Five polls, not eight.
    expect(pollsFor(world, EPISODES[1].audioUrl)).toBe(1);
    expect(pollsFor(world, EPISODES[0].audioUrl)).toBe(4);
    expect(world.calls.filter((call) => call.url.includes("/v2/transcript/"))).toHaveLength(5);
    // Three waits for four rounds — asked for, and recorded rather than taken.
    expect(run.slept).toEqual([
      { duration: POLL_DELAY },
      { duration: POLL_DELAY },
      { duration: POLL_DELAY },
    ]);

    // And the digest is in PUBLICATION order, not completion order. The feed is
    // sorted newest-first for a reason, and a reader should not be able to tell
    // which episode the provider happened to finish first.
    expect(output.lastDigest?.episodes.map((one) => one.title)).toEqual([
      EPISODES[0].title,
      EPISODES[1].title,
    ]);
    // Each entry still carries its own transcript, which is the assertion that
    // a batch crossing two episodes' results would fail.
    expect(output.lastDigest?.episodes[0]?.summary).toContain(EPISODES[0].sentinel);
    expect(output.lastDigest?.episodes[1]?.summary).toContain(EPISODES[1].sentinel);
    expect(output.lastDigest?.episodes.every((one) => one.transcriptSource === "assemblyai")).toBe(
      true,
    );
  });

  test("one broken episode does not sink the digest, and the message says why", async ({ app }) => {
    // The partial-failure policy, driven end to end: a 400 on ONE episode's
    // submit is terminal — the same URL answers the same way on the fourth
    // attempt — so it becomes an `unavailable` VALUE rather than a throw. The
    // digest of the other episode still goes out.
    const world = scriptWorld({ [EPISODES[0].audioUrl]: { submitStatus: 400 } });

    const run = await app.run(dailyDigest, input());

    expect(run.error).toBeUndefined();
    expect(run.status).toBe("completed");
    const episodes = run.output?.lastDigest?.episodes ?? [];
    expect(episodes).toHaveLength(2);

    // The broken one is an ENTRY with a stated reason, not a gap. Four
    // summaries and silence looks like the feed simply had four episodes.
    const broken = episodes[0];
    expect(broken?.title).toBe(EPISODES[0].title);
    expect(broken?.transcriptSource).toBe("unavailable");
    expect(broken?.summary).toContain("could not be transcribed");
    expect(broken?.summary).toContain(EPISODES[0].audioUrl);
    expect(broken?.keyPoints).toEqual(["No transcript was available to summarize."]);

    // The good one is untouched.
    expect(episodes[1]?.transcriptSource).toBe("assemblyai");
    expect(episodes[1]?.summary).toContain(EPISODES[1].sentinel);

    // The model was asked about ONE episode, not two — a broken episode costs
    // nothing beyond the submit that refused it.
    expect(world.calls.filter((call) => call.url.includes("/chat/completions"))).toHaveLength(1);
    // And the reason reaches SLACK, which is the only place a reader will see
    // it. A digest that hid the failure is the outcome this refuses.
    expect(JSON.stringify(slackPosts(world)[0])).toContain("could not be transcribed");
  });

  test("a job that never finishes degrades instead of replaying forever", async ({ app }) => {
    // The poll budget is bounded, and running out of it is NOT an error: a
    // partial digest beats none, and the reason names where the transcript
    // still is. An unbounded loop is the failure this replaces — a run the
    // platform would replay for as long as the provider stayed quiet.
    const world = scriptWorld({
      // Past the budget, so this job is never done.
      [EPISODES[0].audioUrl]: { pendingPolls: MAX_POLL_ATTEMPTS + 1 },
      [EPISODES[1].audioUrl]: { pendingPolls: 0 },
    });

    const run = await app.run(dailyDigest, input());

    expect(run.error).toBeUndefined();
    expect(run.status).toBe("completed");
    const episodes = run.output?.lastDigest?.episodes ?? [];

    const stuck = episodes[0];
    expect(stuck?.transcriptSource).toBe("unavailable");
    // It names the CHECK COUNT and where the transcript can still be read,
    // which is the difference between "we gave up" and "we gave up, here it is".
    expect(stuck?.summary).toContain(`after ${MAX_POLL_ATTEMPTS} checks`);
    expect(stuck?.summary).toContain(`${TRANSCRIBE_API}/v2/transcript/`);
    // The other episode still shipped.
    expect(episodes[1]?.transcriptSource).toBe("assemblyai");

    // The budget really bounded it: one round per attempt, and the fast episode
    // dropped out after the first.
    expect(pollsFor(world, EPISODES[0].audioUrl)).toBe(MAX_POLL_ATTEMPTS);
    expect(pollsFor(world, EPISODES[1].audioUrl)).toBe(1);
    expect(run.slept).toHaveLength(MAX_POLL_ATTEMPTS);
  });
});
