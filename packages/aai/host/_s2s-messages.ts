// Copyright 2026 the AAI authors. MIT license.
/**
 * Wire-format schemas for AssemblyAI S2S server messages.
 *
 * Split out of `s2s.ts` so that file stays under the source line cap, and along
 * the same seam its specs already use: `s2s-events.test.ts` covers event
 * dispatch, `s2s.test.ts` the connection and handle. The two docs disagreements
 * these schemas absorb (`text`/`delta`, `arguments`/`args`) are documented at
 * their fields — a name mismatch here is SILENT, because the union simply
 * rejects the frame and it is dropped as unrecognised.
 */

import { z } from "zod";

export const S2sMessageSchema = z.discriminatedUnion("type", [
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
  // `transcript.agent.delta` is deliberately absent: the events reference
  // documents it, but the live service sends none — see `_s2s-reply.ts`.
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
  z.object({ type: z.literal("session.error"), code: z.string(), message: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export type S2sServerMessage = z.infer<typeof S2sMessageSchema>;

export function parseS2sMessage(obj: Record<string, unknown>): S2sServerMessage | undefined {
  const result = S2sMessageSchema.safeParse(obj);
  return result.success ? result.data : undefined;
}
