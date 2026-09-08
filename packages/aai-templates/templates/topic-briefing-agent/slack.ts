/**
 * Where a briefing GOES when the call ends.
 *
 * A phone call is the worst place to keep anything: the caller hangs up and
 * four researchers' work goes with it. `tools/send_briefing.ts` posts the board
 * to the desk's Slack channel, and this module is the half of that which is
 * about BRIEFINGS.
 *
 * **Everything else belongs to `@alexkroman1/aai/channels`, and that is the
 * point of the split.** Slack has two things people call a webhook URL and they
 * take different bodies; one of them cannot render structure at all; mrkdwn
 * reserves three characters; a 4xx and a 5xx deserve opposite advice. Not one
 * of those rules is about briefings, and a template is the wrong place to learn
 * them — so `slackChannel()` names the destination and `sendToChannel` posts to
 * it, leaving {@link briefingMessage} as the only thing here that a reader of
 * THIS template has to think about.
 *
 * It is a pure function for the same reason `podcast-digest-workflow`'s is: a spec
 * asserts what the desk would post without a network and without knowing
 * Slack's payload shape. Asserting the payload itself — `renderChannelPayload`,
 * the Block Kit, the escaping — would pin the SDK's rendering from the outside,
 * which is exactly the duplication moving it there removed.
 */

import { type DeepReadonly, type ToolFailure, toolFailure } from "@alexkroman1/aai";
import {
  type ChannelMessage,
  type ChannelSection,
  isSlackWebhookUrl,
  type SlackChannel,
  slackChannel,
} from "@alexkroman1/aai/channels";
import { plural } from "@alexkroman1/aai/utils";
import { type Finding, type FrozenBriefing, totalWork } from "./shared.ts";

/**
 * The variable holding the desk's channel.
 *
 * A webhook URL IS the credential — anyone holding it can post — so it is a
 * deployment secret (`aai secret put SLACK_WEBHOOK_URL`) and never a tool
 * argument. A destination the MODEL can name is a destination a caller can talk
 * it into, and what would go there is everything the desk researched.
 *
 * Deliberately NOT on `agent({ requiredEnv })`, which is the other half of that
 * decision: `requiredEnv` refuses the DEPLOY, and a desk with no Slack channel
 * is still a desk. What it costs is that the miss surfaces mid-call instead, so
 * it has to surface well — see `tools/send_briefing.ts`.
 */
export const DESTINATION_ENV = "SLACK_WEBHOOK_URL";

/**
 * The destination, or a refusal to post to it.
 *
 * `isSlackWebhookUrl` is a SECURITY boundary here and not a typo check: the
 * value becomes the target of a POST carrying everything the desk was told, so
 * anything that is not Slack is an exfiltration endpoint somebody put in a
 * secret. Refusing it before the post is also the only moment at which the
 * refusal is cheap.
 *
 * `SlackChannel | ToolFailure` is this template's own Result idiom, the one
 * `findByAngle` already answers with, so the tool forwards a sentence the desk
 * can say rather than throwing at a caller who is on the line.
 */
export function briefingChannel(webhookUrl: string): SlackChannel | ToolFailure {
  if (!isSlackWebhookUrl(webhookUrl)) {
    return toolFailure(
      `${DESTINATION_ENV} is not a Slack webhook URL, so the desk will not post to it. ` +
        "Tell the caller the briefing cannot be sent and that the destination needs fixing.",
    );
  }
  return slackChannel({ webhookUrl });
}

/**
 * The board as a message — one section per angle, in the order they were
 * researched.
 *
 * `text` is the notification line, and on a Slack workflow trigger it is the
 * WHOLE message, so it stands on its own rather than repeating a heading that
 * arm will never render.
 */
export function briefingMessage(board: FrozenBriefing): ChannelMessage {
  const topic = board.topic ?? "an unnamed subject";
  const angles = board.findings.length;
  return {
    text: `Briefing on ${topic}: ${angles} ${plural(angles, "angle")}`,
    heading: `Briefing: ${topic}`,
    subtitle: costLine(board),
    sections: board.findings.map(findingSection),
  };
}

/**
 * One angle, written out.
 *
 * The summary goes in whole here, which is the one place in this template it
 * does: everywhere else the desk is told to shorten it, because the caller is
 * LISTENING. A reader can skim, so the section keeps what the researcher wrote.
 */
function findingSection(finding: DeepReadonly<Finding>): ChannelSection {
  return { title: finding.angle, body: finding.summary };
}

/** What the briefing cost, as the desk is willing to say it in writing. */
function costLine(board: FrozenBriefing): string {
  const { searches, reads } = totalWork(board.findings);
  return `${searches} ${plural(searches, "search", "searches")}, ${reads} ${plural(reads, "page")} read`;
}
