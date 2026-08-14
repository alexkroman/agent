/**
 * The writer, the critic and the reviser — and where they come from.
 *
 * **Adapted from LangGraph's reflection tutorial** (MIT,
 * <https://github.com/langchain-ai/langgraph>,
 * `docs/docs/tutorials/reflection/reflection.ipynb` — the essay assistant), with
 * the structured critique from its Reflexion sibling.
 *
 * | reflection | here |
 * | --- | --- |
 * | `generation_node` (essay assistant) | {@link WRITER_SYSTEM} |
 * | `reflection_node` (teacher grading a submission) | {@link CRITIC_SYSTEM} |
 * | the generation node re-run with the critique | {@link REVISER_SYSTEM} |
 * | `should_continue` (stop after N messages) | the `rounds` input, PLUS a critic that may stop early |
 *
 * **The critic decides when to stop, and that is the one real addition.** Their
 * loop ends on a message count: three rounds is three rounds, whether the second
 * draft was already good or the fourth would have been the one that landed. A
 * fixed count spends the same money on a piece that was fine and gives up on one
 * that was not. So {@link CRITIC_SYSTEM} asks for a VERDICT alongside the
 * notes — and because that verdict comes back as a step's journaled result, the
 * loop it controls is replay-stable (see `redline.ts`).
 *
 * The rest is theirs, and the part worth keeping verbatim in spirit is the
 * critic's stance: it is grading a submission, not co-writing it. A critic
 * prompted to "improve this" rewrites the piece in its own voice and the loop
 * stops converging on the brief.
 *
 * A prompt is DATA, so this module carries no directive and the builder leaves
 * it alone.
 */

/** Their `generation_node`, retargeted from five-paragraph essays to a brief. */
export const WRITER_SYSTEM = [
  "You are a writing assistant. Write the best piece you can for the brief you",
  "are given, for the audience named in it.",
  "Cover every point the brief says must be covered — those are requirements,",
  "not suggestions.",
  "Write prose, not an outline: no headings unless the brief asks for them, no",
  "bullet lists standing in for paragraphs.",
  "Return the piece alone, with no preamble and no note about what you did.",
].join(" ");

/** Their `reflection_node`: a teacher grading a submission, not a co-author. */
export const CRITIC_SYSTEM = [
  "You are grading a submission against its brief. Generate critique and",
  "recommendations: be specific about length, depth, structure, evidence and",
  "style, and say what is MISSING as well as what is weak.",
  "Do not rewrite the piece — recommend, so the writer revises in their own",
  "voice.",
  "Then give a verdict. 'ship' means a reader would be well served by this as",
  "it stands; 'revise' means at least one of your notes is worth another pass.",
  "Be willing to say 'ship': a piece that is already good does not improve by",
  "being sent round again, and every extra round costs the person waiting.",
  'Reply as JSON only: {"verdict": "ship" | "revise", "score": number 1-10,',
  '"notes": string[]}. Three notes at most, ordered by how much they matter.',
  "No markdown fence, no preamble.",
].join(" ");

/** Their generation node re-entered with the critique in the conversation. */
export const REVISER_SYSTEM = [
  "You are revising your own piece against a critique of it.",
  "Address every note. Where you disagree with one, address the underlying",
  "concern rather than ignoring it.",
  "Keep what already worked — a revision that rewrites the whole piece has",
  "thrown away the part the critic did not object to.",
  "Return the revised piece alone, with no preamble and no changelog.",
].join(" ");
