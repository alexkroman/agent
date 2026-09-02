// Copyright 2026 the AAI authors. MIT license.
/**
 * A step body may not WAIT, and this is the check that says so.
 *
 * `ctx.sleep` and `ctx.waitFor` belong to the body. The closure a step is handed
 * CAPTURES `ctx`, though, so `ctx.step("napper", () => ctx.sleep("nap", 2000))`
 * is one line away at every call site — and until this module existed the engine
 * ran it, silently and wrongly, in three distinct ways. Naming the waits closed
 * one of them; the refusal is still owed for the other two.
 *
 * ## What it really cost, measured
 *
 * A suspend unwinds out of the step, the attempt charge is RELEASED (a suspend
 * settles nothing, which is correct — see "An attempt is a LEASE" in
 * `workflow-replay-step.ts`), and so the step is never journaled. Everything
 * about that is working as designed, and together it produces:
 *
 * - **The body re-runs from the top on every delivery.** A step that calls a paid
 *   provider or writes a file does it once per suspend. Reproduced: a one-step
 *   body logged `napper` **twice** across two deliveries and reported `completed`.
 * - **And every LATER wait in the run read the wrong record — until the waits
 *   were NAMED.** This was the sharper half and is not a duplicate-work problem
 *   at all. Waits were keyed POSITIONALLY (`sleep!0`, `hook!0`) off a counter
 *   that advances only when a wait is REACHED — and a settled step's body is not
 *   re-executed, so its wait stops being reached the moment the step lands. Every
 *   wait after it slid one place down the key space and read its predecessor's
 *   record. Reproduced, and this is the whole run:
 *
 *   ```text
 *   walk 1  napper enters, sleep!0 claimed          -> suspended
 *   walk 2  napper enters again, sleep!0 elapsed,
 *           napper#0 journaled, body-level sleep!1  -> suspended, wakeAt = +7 days
 *   walk 3  napper answered from the journal (body
 *           NOT run), body-level wait is now
 *           sleep!0 — which elapsed on walk 2       -> completed
 *   ```
 *
 *   The week-long wait was skipped in full, with the clock unmoved between walks
 *   2 and 3, and the run reported `completed`. A durable schedule silently did
 *   not happen. A wait inside a step was the one shape that GUARANTEED it, since
 *   settling the step is what changes the count.
 *
 *   **This half is CLOSED, and not by this check.** Keys are
 *   `sleep!${label}#${occurrence}` and `hook!${token}#${occurrence}` now, so the
 *   walk-3 line above reads `sleep!final#0` whether or not `napper`'s wait was
 *   reached, and the count changing costs nothing. It is recorded here because
 *   the transcript is the clearest statement of what positional keys did, and
 *   because it is one of three reasons for this refusal rather than the whole of
 *   it — the other two are below and both stand.
 *
 * ## Why refusing, rather than warning or typing it
 *
 * So TWO of the three reasons survive named keys: the duplicate execution above,
 * and the liveness argument below — which is the strongest of the three and
 * would carry the refusal on its own.
 *
 * There is no legitimate use. A step body that wants a real delay wants a timer
 * (`sleep` from `@alexkroman1/aai/internal`), not a durable suspension — a
 * durable wait exists to free the process, which is exactly what a step cannot
 * do. So nothing correct is being refused, and a warning would leave a skipped
 * week-long schedule in place while narrating it.
 *
 * **And since suspension stopped being a THROW, this refusal is what keeps the
 * walk LIVE as well as correct.** A wait parks on a promise that never settles
 * (`workflow-replay-suspend.ts`), and quiescence is "no engine operation in
 * flight" — so a wait inside a step is a step awaiting a promise that cannot
 * settle, holding the walk open against the very check that would suspend it.
 * `replayRun` would never return. Measured by A/B: with this check disabled,
 * all eight cases in the spec beside this module stop failing and start timing
 * OUT at the suite's 5-second ceiling. That is a strictly worse failure than a
 * duplicated step body, and it is why the refusal must land BEFORE the wait is
 * claimed.
 *
 * **A TYPE cannot reach this.** The `Literal<Name>` guard on `ctx.step`'s name
 * types an ARGUMENT; this would have to retype a CAPTURED BINDING — the outer
 * `ctx` is lexically in scope inside the closure and no step-scoped parameter can
 * remove it. TypeScript has no effect system, so a narrowed `ctx` handed to the
 * callback would be advice, not a gate. Runtime is the only layer that sees it.
 *
 * ## The refusal is a verdict about the WALK
 *
 * Recorded through `replayRun`'s `refused`, like a divergence and an abandoned
 * step, so a body that catches broadly cannot turn it into `completed`. Thrown as
 * a `FatalError` so the attempt loop neither retries it nor treats it as
 * transient: re-delivering cannot make a body legal.
 */

import { FatalError } from "@alexkroman1/aai/step-errors";
import { currentRun } from "./workflow-run-context.ts";

/**
 * The refusal for `method` called inside a step, or `undefined` at body level.
 *
 * Reads the run context rather than taking a flag, because that context is
 * already narrowed to the step by `withStepContext` for the whole of the body's
 * execution — including inside every helper it awaits, which is exactly where an
 * accidental `ctx.sleep` hides. A caller-passed flag would see only the
 * outermost frame.
 *
 * Names the step, because a body with a fan-out has several and the message is
 * the whole diagnosis an author gets.
 *
 * @internal
 */
export function waitInsideStep(method: string): FatalError | undefined {
  const step = currentRun()?.step;
  if (step === undefined) return undefined;
  return new FatalError(
    `${method} was called inside ctx.step("${step.name}"), and a step body may not wait. ` +
      "A suspend unwinds out of the step without journaling it, so the body re-runs " +
      "from the top — side effects included — on every delivery; and a wait parks on " +
      "a promise that never settles, so the step awaits something that cannot happen " +
      "and this delivery never returns at all. Move the wait out of the step and into " +
      `the workflow body: await ctx.step("${step.name}", …) then await ${method}(…).`,
  );
}
