// Copyright 2026 the AAI authors. MIT license.
/**
 * Filing the finished research — the step that used to be a promise.
 *
 * `file` returned the string `"filed"` and wrote nothing, with a comment saying
 * so. That is the one place a research desk stops being a worked example: the
 * whole shape is **answer the caller now, finish the work later**, and "later"
 * has to end somewhere a person who was not on the call can read it. A run whose
 * last step is a no-op has no such place, so the report lived and died on the
 * run — and `file_it_now`, whose entire description is "file it immediately",
 * skipped a wait in order to reach it.
 *
 * ## Where it goes is the SDK's job
 *
 * `@alexkroman1/aai/channels` owns the destination: `slackChannel()` names it,
 * `sendToChannelOrFail` (`@alexkroman1/aai/step-errors`) posts and classifies —
 * a 4xx is a `FatalError`, because a revoked webhook answers identically on
 * every retry, and a 5xx is a `RetryableError` carrying Slack's own
 * `Retry-After`. None of that is written here, and the module doc of
 * `podcast-digest/workflows/slack.ts` argues why at length. What is left is the
 * part that is about RESEARCH: what a filed report says.
 *
 * ## The channel is OPTIONAL, and that is deliberate
 *
 * `stepEnv` rather than `requireStepEnv`: a desk with no webhook configured
 * still researches, still announces, and still reads its findings back down the
 * phone — it just has nowhere to file them, which it says. That is the same
 * stance `agent.ts` takes on `DATABASE_URL`, and it is what lets someone run
 * this template before they have decided anything. A required credential here
 * would fail the LAST step of a five-minute run.
 *
 * ## What is filed is the SUMMARY and the sources, not the report
 *
 * The report is markdown with a `## Sources` list and can run to pages; a chat
 * message is not where a reader wants it, and every channel has a per-block size
 * limit a long one would meet. So the message carries what a person needs to
 * decide whether to go and read it — the two sentences, the angles, and what was
 * actually read — and the report itself stays on the run, where
 * `ctx.workflows.get(runId)` and a page can reach it in full.
 */

import {
  type ChannelMessage,
  type ChannelSection,
  isSlackWorkflowTriggerUrl,
  type SlackChannel,
  slackChannel,
} from "@alexkroman1/aai/channels";
import { stepEnv, stepReport } from "@alexkroman1/aai/step";
import { sendToChannelOrFail } from "@alexkroman1/aai/step-errors";
import { plural } from "@alexkroman1/aai/utils";

/** The webhook a finished report is posted to. Absent means "file nowhere". */
export const FILING_WEBHOOK_ENV = "RESEARCH_SLACK_WEBHOOK_URL";

/** The Slack workflow variable the whole message lands in, on a trigger URL. */
export const FILING_TEXT_PARAM_ENV = "RESEARCH_SLACK_TEXT_PARAM";

/**
 * One angle, as a filed report names it.
 *
 * Structural rather than an import of `Note` from `research.ts`: that module
 * imports {@link file} from this one, and a type-only edge back would still be
 * a cycle a reader has to hold in their head. A `Note` satisfies this.
 */
export type FiledAngle = {
  readonly angle: string;
  readonly sources: readonly { readonly title: string; readonly url: string }[];
};

/** Everything a filed report says. */
export type Filing = {
  readonly topic: string;
  /** Who asked — `researchFlow`'s `requestedBy`, which is the calling session. */
  readonly requestedBy: string;
  /** The two sentences, the same ones the agent reads down the phone. */
  readonly summary: string;
  readonly angles: readonly FiledAngle[];
};

/**
 * The destination, or `undefined` when this deployment has none.
 *
 * The `textParam` is decided rather than forwarded: it names a Slack WORKFLOW
 * variable, so it means something on a trigger URL and quietly nothing on an
 * incoming webhook — and a setting that does nothing is worse than an absent
 * one, because it looks configured. `isSlackWorkflowTriggerUrl` is what tells
 * the two apart, and the SDK folds a rich message down to `text` for the
 * trigger case anyway, which is why {@link renderFiling}'s `text` has to stand
 * on its own.
 */
export function filingChannel(): SlackChannel | undefined {
  const webhookUrl = stepEnv(FILING_WEBHOOK_ENV);
  if (!webhookUrl) return undefined;
  const textParam = stepEnv(FILING_TEXT_PARAM_ENV);
  return slackChannel(
    textParam && isSlackWorkflowTriggerUrl(webhookUrl) ? { webhookUrl, textParam } : { webhookUrl },
  );
}

/**
 * The filed report as a channel message — PURE, so a spec asserts what a run
 * would post without a network and without knowing any channel's payload shape.
 */
export function renderFiling(filing: Filing): ChannelMessage {
  const sources = sourceCount(filing);
  return {
    // The notification line — what a push alert and a screen reader read.
    text: `${filing.topic}: ${filing.summary}`,
    heading: `Research: ${filing.topic}`,
    subtitle: `Requested by ${filing.requestedBy} · ${sources} ${plural(sources, "source")} across ${filing.angles.length} ${plural(filing.angles.length, "angle")}`,
    // The ANSWER is a section rather than only `text`, and a spec caught that:
    // a plain-text destination renders `heading ?? text`, so a message whose
    // summary lived only in `text` loses it in exactly the place the whole
    // message is one string.
    sections: [{ title: "In short", body: filing.summary }, ...angleSections(filing.angles)],
  };
}

/** One section per angle, its sources listed as what was actually read. */
function angleSections(angles: readonly FiledAngle[]): ChannelSection[] {
  return angles.map((angle) => ({
    title: angle.angle,
    bullets: angle.sources.map((source) => `${source.title} — ${source.url}`),
  }));
}

/** Distinct sources across every angle — the same number the agent quotes. */
function sourceCount(filing: Filing): number {
  return new Set(filing.angles.flatMap((angle) => angle.sources.map((one) => one.url))).size;
}

/**
 * File it, and answer with when it was filed.
 *
 * `new Date()` inside a STEP rather than `ctx.now()` in the body: a step's
 * result is journaled, so the timestamp a replay reads back is the one the first
 * attempt wrote. `ctx.now()` is for a decision the BODY makes, where there is no
 * journaled result to reproduce it from.
 *
 * The return value used to be the literal `"filed"` under a field called
 * `filedAt`, which was two claims and neither was true.
 */
export async function file(filing: Filing): Promise<string> {
  const channel = filingChannel();
  if (channel) {
    await stepReport(`Filing the findings to the ${channel.kind} channel.`);
    await sendToChannelOrFail(channel, renderFiling(filing));
  } else {
    // Not a failure, and it must not read like one: nothing about the research
    // is worse for having nowhere to go, and the report is on the run.
    await stepReport(
      `Filing the findings: no ${FILING_WEBHOOK_ENV} is set, so the report stays on the run.`,
    );
  }
  return new Date().toISOString();
}
