// Copyright 2026 the AAI authors. MIT license.
/**
 * What an agent IS, in one line, for whoever reads a LIST of them — and the
 * one rule the field carries: its audience is never the model.
 *
 * Split off `types.ts` as a field group for the reason every group is one
 * (that file is at the cap, and a group with one rule is its own interface).
 * The field used to be called `description`, which reads like the sentence a
 * `ToolDef.description` or a `SpeakerDef.description` hands the model — and
 * two of three authors wrote model-facing prose into it. `listing` says who
 * reads it; the old name is refused by `assertNoStrayFields` naming this one.
 */

/**
 * The listing field group — see this module's header.
 *
 * @input
 * @public
 */
export interface AgentListing {
  /**
   * What this agent IS, in one line, for whoever is reading a LIST of them.
   *
   * Its audience is never the model — a registry page, an A2A card, the
   * studio's agent picker, the CLI's `aai list`. Write it as the job the agent
   * does ("Books and reschedules dental appointments"), not as instructions;
   * the instructions are `system-prompt.md`, and a line of context for the
   * model is `promptContext`.
   *
   * Serializable, unlike most of what an author declares, and that is the whole
   * point: `tools`, `events` and `workflows` are host-only because a consumer
   * of a stored config could not act on a function, but a listing is exactly
   * what such a consumer wants and could not get.
   */
  listing?: string;
}
