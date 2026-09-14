// Copyright 2026 the AAI authors. MIT license.
/**
 * What `listen_for` will and will not pass to the recognizer.
 *
 * The cases are the terms a graded tau2-bench retail run actually produced
 * with the tool live — which is the point: both the description and the
 * guidance already said "the caller will say back", and the model passed
 * login ids anyway, because that is the field a lookup result hands it. A
 * rule the prompt could not hold is a rule the code has to.
 */

import { describe, expect, it, vi } from "vitest";
import { createListenFor, spokenTerms } from "./_listen-for.ts";
import { createMockToolContext } from "./_test-utils.ts";

describe("spokenTerms", () => {
  it("keeps what a person pronounces", () => {
    const { kept, dropped } = spokenTerms(["Yusuf Rossi", "W2378156", "Water Bottle"]);
    expect(kept).toEqual(["Yusuf Rossi", "W2378156", "Water Bottle"]);
    expect(dropped).toEqual([]);
  });

  it("STRIPS a leading # rather than refusing the term", () => {
    // The right value written the wrong way — and the agent's own prompt
    // rules tell it to write an id with the "#" dropped, so repairing keeps
    // a good term instead of discarding one.
    expect(spokenTerms(["#W6390527"]).kept).toEqual(["W6390527"]);
  });

  it("DROPS a login id, because there is no repair", () => {
    // `yusuf_rossi_9620` is a different string from the name it was derived
    // from; guessing "Yusuf Rossi" out of it would bias toward a name the
    // record may not hold.
    const { kept, dropped } = spokenTerms(["yusuf_rossi_9620", "mei_kovacs_8020"]);
    expect(kept).toEqual([]);
    expect(dropped).toEqual(["yusuf_rossi_9620", "mei_kovacs_8020"]);
  });

  it("drops an email, which is spoken as letters rather than as itself", () => {
    expect(spokenTerms(["yusuf@example.com"]).kept).toEqual([]);
  });

  it("KEEPS a bare digit run", () => {
    // A caller really does read out an item number, a ZIP or the last four of
    // a card, and the default prompt's spelling rules treat those as
    // identifiers for exactly that reason.
    expect(spokenTerms(["9647292434", "28236"]).kept).toEqual(["9647292434", "28236"]);
  });

  it("partitions a mixed list the model actually sent", () => {
    const { kept, dropped } = spokenTerms(["T-Shirt", "#W6247578", "yusuf_rossi_9620"]);
    expect(kept).toEqual(["T-Shirt", "W6247578"]);
    expect(dropped).toEqual(["yusuf_rossi_9620"]);
  });
});

describe("listen_for", () => {
  it("steers with the kept terms only, and names what it ignored", async () => {
    const steerRecognizer = vi.fn(() => true);
    const result = await createListenFor().execute(
      { terms: ["Yusuf Rossi", "yusuf_rossi_9620"] },
      createMockToolContext({ steerRecognizer }),
    );
    expect(steerRecognizer).toHaveBeenCalledWith(["Yusuf Rossi"]);
    expect(result).toMatchObject({ listening_for: ["Yusuf Rossi"] });
    expect(JSON.stringify(result)).toContain("yusuf_rossi_9620");
  });

  it("does not steer at all when nothing is sayable, and says why", async () => {
    // The measured first call of the run this filter came from. Spending a
    // session slot here would bias toward a string no recognizer can emit.
    const steerRecognizer = vi.fn(() => true);
    const result = await createListenFor().execute(
      { terms: ["yusuf_rossi_9620"] },
      createMockToolContext({ steerRecognizer }),
    );
    expect(steerRecognizer).not.toHaveBeenCalled();
    expect(result).toMatchObject({ listening_for: [] });
    expect(JSON.stringify(result)).toContain("not the ids a record stores them under");
  });
});
