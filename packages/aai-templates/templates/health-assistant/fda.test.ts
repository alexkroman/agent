/**
 * The half of `fda.ts` that `agent.test.ts` cannot reach.
 *
 * That spec replaces `fetchFdaLabel` with a `vi.fn()`, which is right for what
 * it is about — the cross-mention scan, the refuse-on-a-missing-drug rule — and
 * leaves the lookup itself, the cache and the section readers untested. This
 * file drives the REAL function, with no module mocking at all: `CallOptions`
 * carries a `fetch`, documented as being for exactly this, so the query openFDA
 * receives and the signal it is cancelled by are both observable from here
 * while `fetchJson`'s own screening, deadline and byte cap stay in the path.
 *
 * Drug names are unique per test on purpose — the cache in `fda.ts` is module
 * state shared by every test in this file, which is the same thing it is in a
 * session and is the reason it exists.
 */

import type { CallOptions } from "@alexkroman1/aai/tools";
import { describe, expect, test, vi } from "vitest";
import { fetchFdaLabel, first, sectionText, toDrugInfo } from "./fda.ts";

/** A fetch that answers one JSON body and records the requests it was given. */
function stubFetch(body: unknown, status = 200) {
  const calls: { url: string; signal: AbortSignal | null | undefined }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), signal: init?.signal });
    return new Response(JSON.stringify(body), { status });
  });
  return { calls, options: { fetch } satisfies CallOptions };
}

const ASPIRIN = {
  results: [
    {
      openfda: { generic_name: ["ASPIRIN"], manufacturer_name: ["SMITH &amp; NEPHEW"] },
      purpose: ["Pain reliever"],
    },
  ],
};

describe("fetchFdaLabel", () => {
  test("asks openFDA for the generic OR brand match and answers the first result", async () => {
    const { calls, options } = stubFetch(ASPIRIN);

    const label = await fetchFdaLabel("Aspirin", options);

    expect(label).toMatchObject({ purpose: ["Pain reliever"] });
    // Lowercased and URL-encoded, and BOTH fields searched — a caller who says
    // "Advil" has to reach the same label as one who says "ibuprofen".
    expect(calls[0]?.url).toContain('openfda.generic_name:"aspirin"');
    expect(calls[0]?.url).toContain('openfda.brand_name:"aspirin"');
  });

  test("a second question about the same drug does not go back to the network", async () => {
    // The whole reason the cache is in this module rather than in either tool:
    // a session that looks a drug up and then checks it for interactions would
    // otherwise pay the round-trip twice.
    const { options } = stubFetch({ results: [{ purpose: ["Anticoagulant"] }] });

    await fetchFdaLabel("dabigatran", options);
    await fetchFdaLabel("DABIGATRAN", options);

    expect(options.fetch).toHaveBeenCalledTimes(1);
  });

  test("a failed lookup is NOT cached, so the next turn retries", async () => {
    // openFDA answers 404 for a search that matches nothing, which `fetchJson`
    // reports as a `ToolFailure` rather than throwing. Caching it would pin a
    // transient outage for the rest of the call.
    const { options } = stubFetch({ error: { code: "NOT_FOUND" } }, 404);

    expect(await fetchFdaLabel("sparkleforin", options)).toBeNull();
    expect(await fetchFdaLabel("sparkleforin", options)).toBeNull();

    expect(options.fetch).toHaveBeenCalledTimes(2);
  });

  test("the caller's signal reaches the request", async () => {
    // What `CallOptions.signal` buys this template: `check_drug_interaction`
    // fires one of these per drug, and a hang-up mid-check has to take them all
    // down. The signal the request sees is a COMBINED one — `fetchJson` folds
    // its own deadline in — so the claim is that aborting the caller's aborts it.
    const { calls, options } = stubFetch({ results: [{ purpose: ["Statin"] }] });
    const controller = new AbortController();

    await fetchFdaLabel("rosuvastatin", { ...options, signal: controller.signal });
    const seen = calls[0]?.signal;
    expect(seen?.aborted).toBe(false);

    controller.abort();
    expect(seen?.aborted).toBe(true);
  });
});

describe("label section readers", () => {
  test("first decodes the entities SPL leaves in the text", () => {
    // Read ALOUD by a voice agent: "SMITH ampersand-a-m-p" is the failure.
    expect(first(["SMITH &amp; NEPHEW"])).toBe("SMITH & NEPHEW");
    expect(first("it&#39;s a bare string, not an array")).toBe("it's a bare string, not an array");
  });

  test("first answers undefined for anything that is not a string", () => {
    // The runtime half of dropping the `as string[] | undefined` casts: openFDA
    // serves `effective_time` and `id` as bare values and a section can be
    // missing entirely, and neither may crash a lookup.
    expect(first(undefined)).toBeUndefined();
    expect(first([])).toBeUndefined();
    expect(first([{ not: "a string" }])).toBeUndefined();
    expect(first(20_240_101)).toBeUndefined();
  });

  test("sectionText joins every entry, so a split section is scanned whole", () => {
    // A Drug Interactions section split across entries with the cross-mention
    // in the second one is exactly the case where reading only the first would
    // report "no interaction found".
    expect(sectionText(["Ask a doctor.", "Do not use with WARFARIN."])).toBe(
      "Ask a doctor. Do not use with WARFARIN.",
    );
    expect(sectionText(undefined)).toBe("");
  });

  test("toDrugInfo scans the whole decoded section, not just its first entry", () => {
    const info = toDrugInfo("ibuprofen", {
      openfda: { generic_name: ["IBUPROFEN"] },
      drug_interactions: ["Ask a doctor before use.", "Taking with WARFARIN &amp; aspirin."],
    });

    expect(info.interactionsText).toContain("warfarin & aspirin");
    expect(info.aliases).toEqual(["ibuprofen"]);
  });
});
