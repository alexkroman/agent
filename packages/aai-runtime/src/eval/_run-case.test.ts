// Copyright 2026 the AAI authors. MIT license.
/**
 * `runCase` noting the failing try for the `AAI_EVAL_REPEAT` summary — the
 * wiring between a case's session and `SuiteSpread`, which neither half's own
 * spec can see: `_spread.test.ts` hands `noteTranscript` a string it made up,
 * and `transcript.test.ts` never throws.
 */

import { agent } from "@alexkroman1/aai";
import { describe, expect, onTestFinished, test } from "vitest";
import { suiteNetwork } from "./_network-install.ts";
import { runCase } from "./_run-case.ts";
import { runRepeats, SuiteSpread } from "./_spread.ts";
import { evalNetwork } from "./network.ts";

describe("runCase", () => {
  test("a failing body leaves its try's transcript for the summary, refusals included", async () => {
    const net = suiteNetwork("stub", []);
    net.install();
    onTestFinished(() => net.restore());
    const failing = runCase({
      agent: agent({ name: "Desk" }),
      mode: "stub",
      options: { network: evalNetwork() },
      caseOptions: { stubReply: "One moment, please." },
      net,
      body: async ({ session }) => {
        await session.say("Book a table for four.");
        await fetch("https://api.twilio.com/Calls").catch(() => undefined);
        throw new Error("expected 'One moment, please.' to match /booked/i");
      },
    });
    await expect(failing).rejects.toBeInstanceOf(Error);
    const thrown: unknown = await failing.catch((err: unknown) => err);
    const transcript = new SuiteSpread("s").record("books it", thrown).firstTranscript;
    expect(transcript).toContain("User: Book a table for four.");
    expect(transcript).toContain("Agent: One moment, please.");
    expect(transcript).toContain("GET https://api.twilio.com/Calls (refused)");
  });

  test("the failure a suite reports carries the transcript under its own message", async () => {
    const net = suiteNetwork("stub", []);
    const once = () =>
      runCase({
        agent: agent({ name: "Desk" }),
        mode: "stub",
        options: undefined,
        caseOptions: { stubReply: "One moment, please." },
        net,
        body: async ({ session }) => {
          const turn = await session.say("Book a table for four.");
          expect(turn.text).toMatch(/booked/i);
        },
      });
    const thrown = await runRepeats(once, "books it", 1, new SuiteSpread("s")).catch(
      (err: unknown) => err,
    );
    const message = (thrown as Error).message;
    // The assertion stays FIRST, so vitest's headline is still the claim.
    expect(message.split("\n")[0]).toBe("expected 'One moment, please.' to match /booked/i");
    expect(message).toMatch(
      /\n\n--- the failing try ---\n(.*\n)*User: Book a table for four\.\nAgent: One moment, please\.$/,
    );
  });

  test("`network` beside `fetch` is refused before anything is installed", async () => {
    const net = suiteNetwork("stub", []);
    await expect(
      runCase({
        agent: agent({ name: "Desk" }),
        mode: "stub",
        options: { network: evalNetwork(), fetch: globalThis.fetch },
        caseOptions: undefined,
        net,
        body: async () => undefined,
      }),
    ).rejects.toThrow(/`network` replaces `fetch` and `workflowOptions.stepFetch`/);
  });
});
