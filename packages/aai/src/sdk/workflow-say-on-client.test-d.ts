// Copyright 2026 the AAI authors. MIT license.
/**
 * `SayOnClientNotice` is spelled out rather than derived from
 * `StepSayOnClientOptions` (see its doc), so these pin the two together: a
 * field `stepSayOnClient` grows fails here until the notice carries it too.
 */

import { expectTypeOf, test } from "vitest";
import type { StepSayOnClientOptions } from "./step-say-on-client.ts";
import type { SayOnClientNotice } from "./workflow-say-on-client.ts";

test("the notice is stepSayOnClient's options, id optional, plus maxAttempts", () => {
  expectTypeOf<
    Exclude<keyof StepSayOnClientOptions, keyof SayOnClientNotice>
  >().toEqualTypeOf<never>();
  expectTypeOf<
    Exclude<keyof SayOnClientNotice, keyof StepSayOnClientOptions>
  >().toEqualTypeOf<"maxAttempts">();
  expectTypeOf<Omit<SayOnClientNotice, "id" | "maxAttempts">>().toEqualTypeOf<
    Omit<StepSayOnClientOptions, "id">
  >();
});
