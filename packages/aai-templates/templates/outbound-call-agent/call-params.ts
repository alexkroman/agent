// Copyright 2026 the AAI authors. MIT license.
/**
 * What a placed call carries to the session that answers it, and the
 * signature that proves this app placed it.
 *
 * `stepPlaceCall` hands Twilio a set of `<Parameter>`s, and the answering
 * session reads them back as `call.parameters` in `sessionContext` — before the
 * first model call. That is the ONLY channel between the run that dialled and
 * the session that talks, so the call's whole brief travels on it: the call id,
 * the task prompt, and a signature over both.
 *
 * ## Why the prompt rides on the call instead of being looked up
 *
 * `sessionContext` is handed `env` and the call, and nothing that reads a
 * workflow run — and it has 1.5 seconds. Carrying the prompt on the call means
 * the session needs no store, no lookup and no network: the brief arrives with
 * the audio. Twilio caps each parameter at 500 characters (name plus value) and
 * a stream at 32 of them, so the prompt is cut into {@link CHUNK_CHARS} pieces
 * named `p0`, `p1`, … — {@link MAX_PROMPT_CHARS} fits with room to spare.
 *
 * ## Why it is signed
 *
 * `WS /phone` is unauthenticated — anyone who learns the agent's URL can open
 * a stream and claim any parameters they like, and spend the agent's model on
 * a conversation of their choosing. So {@link signCall} computes an HMAC over
 * the id and the prompt with `CALLS_API_KEY`, and {@link readCall} answers
 * `undefined` for a stream whose signature does not verify; `agent.ts` turns
 * that into `{ refuse }`, which hangs up before the greeting or any model call.
 *
 * Web Crypto rather than `node:crypto`: it is a global in Node, in the guest
 * and in a browser alike, so this module imports nothing.
 */

/** Characters of prompt per `<Parameter>` — under Twilio's 500 with the name. */
export const CHUNK_CHARS = 450;

/** The longest task prompt a call accepts — nine chunks, well inside 32 parameters. */
export const MAX_PROMPT_CHARS = 4000;

/** What a verified call told its session. */
export type CallBrief = {
  /** This app's call id — `call_…`, the id the API answers with. */
  id: string;
  /** The task, as the API caller wrote it. */
  prompt: string;
};

/** Constant-time comparison, so a forged secret learns nothing from timing. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmac(secret: string, text: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(text));
  return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The signed text: the id, a separator no id contains, and the prompt. */
function signedText(brief: CallBrief): string {
  return `${brief.id}\n${brief.prompt}`;
}

/**
 * The `<Parameter>`s for one call: `call`, `sig`, and the prompt as `p0…pN`.
 *
 * @throws {RangeError} When the prompt is over {@link MAX_PROMPT_CHARS} — the
 *   API's schema refuses that first, so reaching it is a bug.
 */
export async function signCall(brief: CallBrief, secret: string): Promise<Record<string, string>> {
  if (brief.prompt.length > MAX_PROMPT_CHARS) {
    throw new RangeError(`A call prompt is at most ${MAX_PROMPT_CHARS} characters.`);
  }
  const params: Record<string, string> = {
    call: brief.id,
    sig: await hmac(secret, signedText(brief)),
  };
  for (let i = 0; i * CHUNK_CHARS < brief.prompt.length; i++) {
    params[`p${i}`] = brief.prompt.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS);
  }
  return params;
}

/**
 * The brief a stream's parameters carry, or `undefined` when they were not
 * signed by this app — a stranger, a stale secret, or a truncated stream.
 */
export async function readCall(
  params: Readonly<Record<string, string>>,
  secret: string | undefined,
): Promise<CallBrief | undefined> {
  const id = params.call;
  const sig = params.sig;
  if (!(secret && id && sig)) return undefined;
  let prompt = "";
  for (let i = 0; params[`p${i}`] !== undefined; i++) prompt += params[`p${i}`];
  const brief = { id, prompt };
  return safeEqual(sig, await hmac(secret, signedText(brief))) ? brief : undefined;
}
