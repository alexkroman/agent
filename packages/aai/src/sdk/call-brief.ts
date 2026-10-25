// Copyright 2026 the AAI authors. MIT license.
/**
 * What a placed call carries to the session that answers it — the BRIEF — and
 * the signature that proves this app placed it.
 *
 * `stepPlaceCall` hands Twilio a set of `<Parameter>`s, and the answering
 * session reads them back as `call.parameters` in `sessionContext`, before its
 * first model call. That is the ONLY channel between the run that dialled and
 * the session that talks, so the call's whole brief travels on it: the app's
 * own call id, the task prompt, and a signature over both.
 *
 * ## Why the prompt rides on the call instead of being looked up
 *
 * `sessionContext` is handed `env` and the call, and nothing that reads a
 * workflow run — and it has 1.5 seconds. Carrying the prompt on the call means
 * the session needs no store, no lookup and no network: the brief arrives with
 * the audio. Twilio caps each parameter at 500 characters (name plus value) and
 * a stream at 32 of them, so the prompt is cut into {@link CALL_BRIEF_CHUNK_CHARS}
 * pieces named `p0`, `p1`, … — {@link MAX_CALL_BRIEF_PROMPT_CHARS} fits with
 * room to spare beside the app's own parameters.
 *
 * ## Why it is signed
 *
 * `WS /phone` is unauthenticated — anyone who learns the agent's URL can open a
 * stream and claim any parameters they like, and spend the agent's model on a
 * conversation of their choosing. So {@link signCallBrief} computes an HMAC
 * over the id and the prompt with the app's secret, and {@link readCallBrief}
 * answers `undefined` for a stream whose signature does not verify; the app's
 * `sessionContext` turns that into `{ refuse }`, which hangs up before the
 * greeting or any model call.
 *
 * Web Crypto rather than `node:crypto`: it is a global in Node, in the guest
 * and in a browser alike, so this module imports nothing Node-only. The
 * compare is the SDK's one constant-time compare (`_timing-safe-equal.ts`), not
 * a private copy — a private copy is where the early exit creeps back in.
 *
 * @module
 */

import { hmacSha256 } from "./_hmac.ts";
import { timingSafeEqual } from "./_timing-safe-equal.ts";

/** Characters of prompt per `<Parameter>` — under Twilio's 500 with the name. */
export const CALL_BRIEF_CHUNK_CHARS: number = 450;

/** The longest task prompt a brief carries — nine chunks, well inside 32 parameters. */
export const MAX_CALL_BRIEF_PROMPT_CHARS: number = 4000;

/** The default agent-env variable a brief is signed with — see `stepPlaceCall`'s `briefSecretEnv`. */
export const CALL_BRIEF_SECRET_ENV = "CALLS_API_KEY";

/** The parameter names a signed brief occupies: `call`, `sig`, and `p0…pN`. */
const BRIEF_PARAMETER_RE = /^(?:call|sig|p\d+)$/;

/**
 * What a placed call tells the session that answers it, once verified.
 *
 * @public
 */
export type CallBrief = {
  /** The app's own id for the call — the id its API answered with, say. */
  id: string;
  /** The task, as the caller wrote it. At most {@link MAX_CALL_BRIEF_PROMPT_CHARS}. */
  prompt: string;
};

/** The brief's MAC under the secret's UTF-8 bytes, hex-encoded for a `<Parameter>`. */
async function hmacHex(secret: string, text: string): Promise<string> {
  const mac = await hmacSha256(new TextEncoder().encode(secret), text);
  return Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The signed text: the id, a separator no id contains, and the prompt. */
function signedText(brief: CallBrief): string {
  return `${brief.id}\n${brief.prompt}`;
}

/**
 * Whether `name` is one of the parameters a signed brief occupies, so a
 * caller's own `parameters` cannot silently overwrite — or be overwritten by —
 * the brief's.
 *
 * @internal
 */
export function isCallBriefParameter(name: string): boolean {
  return BRIEF_PARAMETER_RE.test(name);
}

/**
 * The `<Parameter>`s for one call: `call`, `sig`, and the prompt as `p0…pN`.
 * What `stepPlaceCall({ brief })` merges into the call's parameters; exported
 * for an app that dials some other way and wants the same wire shape.
 *
 * @throws {RangeError} When the prompt is over {@link MAX_CALL_BRIEF_PROMPT_CHARS},
 *   or the id is empty or carries a newline (the separator of the signed text).
 *
 * @public
 */
export async function signCallBrief(
  brief: CallBrief,
  secret: string,
): Promise<Record<string, string>> {
  if (brief.id === "" || brief.id.includes("\n")) {
    throw new RangeError("A call brief's id is a non-empty single line.");
  }
  if (brief.prompt.length > MAX_CALL_BRIEF_PROMPT_CHARS) {
    throw new RangeError(
      `A call brief's prompt is at most ${MAX_CALL_BRIEF_PROMPT_CHARS} characters.`,
    );
  }
  const params: Record<string, string> = {
    call: brief.id,
    sig: await hmacHex(secret, signedText(brief)),
  };
  for (let i = 0; i * CALL_BRIEF_CHUNK_CHARS < brief.prompt.length; i++) {
    params[`p${i}`] = brief.prompt.slice(
      i * CALL_BRIEF_CHUNK_CHARS,
      (i + 1) * CALL_BRIEF_CHUNK_CHARS,
    );
  }
  return params;
}

/**
 * The brief a call's parameters carry, or `undefined` when they were not
 * signed by this app — a stranger, a stale secret, a truncated stream, or no
 * secret at all (an unset env is a refusal, never an open door).
 *
 * `call.brief(secret)` on the `SessionCall` `sessionContext` receives is this,
 * bound to that call's parameters.
 *
 * @example Refuse a stream the app did not dial
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 *
 * agent({
 *   name: "Errand calls",
 *   telephony: ["twilio"],
 *   async sessionContext({ call, env }) {
 *     const brief = await call?.brief(env.CALLS_API_KEY);
 *     if (!brief) return { refuse: "not a call this app placed" };
 *     return { instructions: `Your task on this call: ${brief.prompt}` };
 *   },
 * });
 * ```
 *
 * @public
 */
export async function readCallBrief(
  call: { readonly parameters: Readonly<Record<string, string>> },
  secret: string | undefined,
): Promise<CallBrief | undefined> {
  const params = call.parameters;
  const id = params.call;
  const sig = params.sig;
  if (!(secret && id && sig)) return undefined;
  let prompt = "";
  for (let i = 0; params[`p${i}`] !== undefined; i++) prompt += params[`p${i}`];
  const brief = { id, prompt };
  return timingSafeEqual(sig, await hmacHex(secret, signedText(brief))) ? brief : undefined;
}
