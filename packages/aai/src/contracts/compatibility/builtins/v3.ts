// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:builtins` epoch 3.
 *
 * A tool body reaching the three keyless network builtins — search the web,
 * read a page, call a JSON API — and narrowing each answer with
 * `isToolFailure`, which is the whole discipline this capability asks for: all
 * three ANSWER `T | ToolFailure` rather than throwing, so an unnarrowed read
 * turns a live `403` into "the web has nothing". Written the way it was
 * authored at epoch 3, and it must keep compiling for as long as that epoch is
 * advertised as supported.
 *
 * ## What moved, and why epoch 3 survives it
 *
 * Epoch 4 EXPORTED `UntypedJsonBody`, the declared default of all three type
 * parameters. It was always the default — it was simply unexported, so it was
 * a name in three public signatures that resolved to nothing a reader could
 * follow, which is what the docs build reports as a warning and turns into a
 * failure.
 *
 * Adding a name breaks nothing that did not name it, which is what makes this
 * a retain rather than a drop. An epoch-3 caller either passed its own `T` —
 * unaffected — or took the default and narrowed the result, which is exactly
 * what the body below does. What it could not do was WRITE the default down;
 * that is the whole of what epoch 4 adds.
 *
 * **The direction that WOULD break this file is a SIGNATURE.** Every name here
 * is invoked and none is implemented, so nothing is insulated by a member
 * being optional the way an interface's consumer is: a narrowed parameter on
 * `fetchJson`, a `CallOptions` field becoming required, a return that stops
 * carrying `| ToolFailure`. Each reddens here and each is a real break for
 * every tool module in every user project.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 3 has to be dropped with a reason.
 */

import { type CallOptions, fetchJson, visitWebpage, webSearch } from "../../../host/agent-tools.ts";
import { isToolFailure, type ToolFailure } from "../../../sdk/utils.ts";

/** What the caller gets back: a headline per source, or the reason there is none. */
export type Briefing = { headlines: string[] } | ToolFailure;

/** The shape this example asks the JSON API for, passed as the explicit `T`. */
type Quote = { symbol: string; price: number };

/**
 * Read three sources and answer with what each one said.
 *
 * `signal` is threaded into every call: a page fetch and a search are the two
 * slowest things a tool does and the ones a barge-in most wants back.
 */
export async function brief(topic: string, signal: AbortSignal): Promise<Briefing> {
  // One bag, threaded into all three calls — `CallOptions` is the reason the
  // three take an object form at all, and the reason a tool can hand its
  // `ctx.signal` to the two slowest things it does.
  const call: CallOptions = { signal };

  // The DEFAULT type parameter — `UntypedJsonBody` at epoch 3, unnameable, and
  // reached exactly as it is at epoch 4: by narrowing rather than by naming.
  const found = await webSearch({ query: topic, maxResults: 3, ...call });
  if (isToolFailure(found)) return found;

  const headlines: string[] = [];
  for (const entry of Object.values(found)) {
    if (typeof entry === "string") headlines.push(entry);
  }

  const page = await visitWebpage({ url: `https://example.com/${topic}`, ...call });
  // An unnarrowed read here is the bug this contract exists to make awkward.
  if (!isToolFailure(page)) headlines.push(String(Object.keys(page).length));

  // The EXPLICIT type parameter, which is the other half of the surface.
  const quote = await fetchJson<Quote>({
    url: "https://example.com/quote",
    headers: { accept: "application/json" },
    ...call,
  });
  if (!isToolFailure(quote)) headlines.push(`${quote.symbol} ${quote.price}`);

  return { headlines };
}
