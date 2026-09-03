// Copyright 2026 the AAI authors. MIT license.
/**
 * The S2S server-message vocabulary: the Zod union every inbound frame is
 * validated against, and the parse that turns an unknown object into one.
 *
 * Split from `s2s.ts` so that file stays the socket and the handle. The union
 * is the riskiest part of the protocol surface to get wrong, because a name
 * mismatch is SILENT — an unmatched frame is dropped as unrecognised rather
 * than raising — which is how live captions went missing in S2S mode.
 */

import { z } from "zod";

// ── Zod schemas for S2S server messages ─────────────────────────────────

const S2sMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.ready"), session_id: z.string() }).passthrough(),
  z
    .object({
      type: z.literal("session.updated"),
      config: z.object({ id: z.string().optional() }).passthrough().optional(),
    })
    .passthrough(),
  z.object({ type: z.literal("input.speech.started") }),
  z.object({ type: z.literal("input.speech.stopped") }),
  z.object({ type: z.literal("transcript.user"), item_id: z.string(), text: z.string() }),
  // Live partial of the current user utterance. `text` is the FULL transcript
  // so far (each delta supersedes the previous one for an item_id), not an
  // increment — so it is passed straight through, never concatenated.
  //
  // The two docs pages disagree on the field name: the events reference says
  // `text`, the message-sequence page's example says `delta`. Accept either,
  // preferring the events reference, exactly as `tool.call` below does for
  // `arguments`/`args` — a name mismatch here is silent (the union rejects the
  // frame and it is dropped as unrecognised), which is how live captions went
  // missing in S2S mode in the first place.
  z
    .object({
      type: z.literal("transcript.user.delta"),
      item_id: z.string().optional(),
      text: z.string().optional(),
      delta: z.string().optional(),
    })
    .transform((m) => ({ type: m.type, text: m.text ?? m.delta ?? "" })),
  z.object({ type: z.literal("reply.started"), reply_id: z.string() }),
  // One WORD of the agent's reply, with its playback offsets. Unlike
  // `transcript.user.delta`, whose `text` is cumulative, this really is an
  // increment and must be APPENDED — see the accumulator in `_s2s-reply.ts`.
  // `text` is accepted as an alias for the same reason `tool.call` accepts
  // `arguments`/`args`: a silent name mismatch here drops the frame.
  z
    .object({
      type: z.literal("transcript.agent.delta"),
      reply_id: z.string().optional(),
      item_id: z.string().optional(),
      delta: z.string().optional(),
      text: z.string().optional(),
      start_ms: z.number().nullish(),
      end_ms: z.number().nullish(),
    })
    .transform((m) => ({ type: m.type, text: m.delta ?? m.text ?? "" })),
  z.object({
    type: z.literal("transcript.agent"),
    text: z.string(),
    reply_id: z.string().optional().default(""),
    item_id: z.string().optional().default(""),
    interrupted: z.boolean().optional().default(false),
  }),
  // AssemblyAI's S2S protocol delivers tool args under `arguments`; older
  // implementations and our internal tests use `args`. Accept either, with
  // `arguments` taking precedence so the live wire format wins.
  z
    .object({
      type: z.literal("tool.call"),
      call_id: z.string(),
      name: z.string(),
      arguments: z.record(z.string(), z.unknown()).optional(),
      args: z.record(z.string(), z.unknown()).optional(),
    })
    .transform((m) => ({
      type: m.type,
      call_id: m.call_id,
      name: m.name,
      args: m.arguments ?? m.args ?? {},
    })),
  z.object({ type: z.literal("reply.done"), status: z.string().optional() }),
  // Recognised on purpose and dispatched nowhere (the dispatcher's `default`
  // arm). The service brackets every reply with these, and while they were
  // absent from the union each one took the unrecognised path and logged a
  // warning — two per reply, for frames there is nothing to do about. That
  // matters beyond noise: this warning is the ONLY signal that a frame the
  // service really sends is not being handled (the missing live captions this
  // module's header describes), and a stream of known-benign entries is what
  // makes such a signal stop being read.
  z.object({ type: z.literal("reply.content_part.started") }).passthrough(),
  z.object({ type: z.literal("reply.content_part.done") }).passthrough(),
  z.object({ type: z.literal("session.error"), code: z.string(), message: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export type S2sServerMessage = z.infer<typeof S2sMessageSchema>;

export function parseS2sMessage(obj: Record<string, unknown>): S2sServerMessage | undefined {
  const result = S2sMessageSchema.safeParse(obj);
  return result.success ? result.data : undefined;
}
