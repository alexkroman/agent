// Copyright 2026 the AAI authors. MIT license.
// `harness-types.ts` has ZERO workspace imports — it is bundled into the
// self-contained guest artifact — so the shapes it shares with the SDK are
// hand-written copies. These assertions are what makes the duplication safe,
// exactly as `limits.test.ts` does it for the constants: a TEST file is never
// bundled, so it may import the SDK the module under test may not.
//
// The assertions that matter here are TYPE-level and are checked by `tsc`
// (`pnpm typecheck` covers this file); the runtime `expect`s exist so the
// failure is also a red test rather than only a red build.

import type { Message as SdkMessage } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import type { Message } from "./harness-types.ts";

/** True only when `A` and `B` are the same type in both directions. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("the guest Message mirrors the SDK's", () => {
  test("the role union is identical", () => {
    // A fourth role, or one dropped, changes what a tool may be handed. The
    // guest's copy has to move with it — this is not the field set below,
    // which is deliberately narrower.
    const same: Exact<Message["role"], SdkMessage["role"]> = true;
    expect(same).toBe(true);
  });

  test("the copy omits exactly the two fields it knows it omits", () => {
    // `toolName` and `toolCallId` are absent ON PURPOSE — see the type's doc:
    // the trial runner hands every tool an empty `messages`, so a tool-result
    // arm never reaches this side and the ids would name nothing.
    //
    // Stated as an EXACT set rather than a subset check, so a THIRD field added
    // to the SDK's `Message` fails here and gets the same decision made about
    // it, instead of joining a silent divergence.
    const omitted: Exact<
      Exclude<keyof SdkMessage, keyof Message>,
      "toolName" | "toolCallId"
    > = true;
    expect(omitted).toBe(true);
  });

  test("a message crosses in either direction", () => {
    // The narrowing must stay ASSIGNABLE both ways: a required field added to
    // either side (or a widened `content`) breaks one of these two, which is
    // the drift that would actually break the harness.
    const toGuest: (m: SdkMessage) => Message = (m) => m;
    const toSdk: (m: Message) => SdkMessage = (m) => m;
    const sample: Message = { role: "tool", content: "{}" };
    expect(toGuest(toSdk(sample))).toEqual(sample);
  });
});
