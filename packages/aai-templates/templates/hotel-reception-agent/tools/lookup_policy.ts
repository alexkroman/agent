import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import { POLICIES, POLICY_TOPICS, policyIndex } from "../policies.ts";

/**
 * Their `build_lookup_policy_tool`: the whole topic index in the description,
 * the topic as an enum, the body as the result. The description is what makes
 * the knowledge base PROGRESSIVE — the model reads twenty one-line entries on
 * every turn and one body when it needs it, rather than twenty bodies always.
 */
export default tool({
  description:
    "Fetch the full hotel or restaurant policy text for one topic. Call this before answering any " +
    "question beyond the quick facts in your instructions - look it up rather than answering from " +
    `memory. Topics:\n${policyIndex()}`,
  inputSchema: z.object({ topic: z.enum(POLICY_TOPICS) }),
  execute({ topic }) {
    return { topic, policy: POLICIES[topic].body };
  },
});
