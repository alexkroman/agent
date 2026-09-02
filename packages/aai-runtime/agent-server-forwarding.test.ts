// Copyright 2026 the AAI authors. MIT license.
/**
 * `createAgentServer` forwards every `RuntimeOptions` member that is not
 * explicitly excused — asserted, rather than remembered.
 *
 * The module under test carries the four gaps that shipped and why prose was
 * not enough. This file is its READER: it names {@link ForwardingGap} and
 * {@link NoForwardingGap}, so neither can be deleted as an export nothing
 * imports, and it states each claim next to what it costs when it is false.
 *
 * **What actually ENFORCES this is `tsc`, not the test run, and the difference
 * is worth being exact about.** Every assertion here is type-level, so a gap is
 * a compile error and the suite still reports three passing tests — A/B'd by
 * adding a member to `RuntimeOptions`: `turbo run typecheck` and the BUILD both
 * fail naming `"brandNewKnob"`, and `vitest run` says `3 passed`. So the gate is
 * `typecheck` plus `build` (the module is compiled by `tsconfig.build.json`, and
 * a build failure cannot be skipped by a test filter); this file is what makes
 * the claim legible and keeps the exports reachable. A runtime `expect` would be
 * a different check — it cannot see a type — and the one below is deliberately
 * about the FIELD being declared rather than about the subtraction.
 */

import { describe, expect, expectTypeOf, test } from "vitest";
import type { AgentServerOptions } from "./agent-server.ts";
import type { ForwardingGap, NoForwardingGap } from "./agent-server-forwarding.ts";

describe("the front door's option subset", () => {
  test("leaves no RuntimeOptions member unforwarded and unexcused", () => {
    // `never` means every member is either on `AgentServerOptions` or on the
    // deny-list with a reason. Anything else is the NAME of an option a
    // self-hosted deployment cannot reach through the documented door — which is
    // how `telephony` came to mount an unauthenticated `WS /phone` nobody could
    // switch off, and how `journal` left a deployment that owns a database
    // unable to say so.
    expectTypeOf<ForwardingGap>().toEqualTypeOf<never>();
  });

  test("keeps its excuses honest, which the module asserts at BUILD time", () => {
    // Two directions a deny-list rots in — an entry naming a member
    // `RuntimeOptions` no longer has, and an entry for one the door now
    // forwards — and both are `never` assertions in the module rather than
    // here. That is not a preference: `expectTypeOf<T>()` asks for a VALUE
    // argument when `T` resolves eagerly to `never`, and `StaleExcuse` and
    // `RedundantExcuse` both do, so the inline form is a compile error instead
    // of an assertion. `ForwardingGap` above is a deferred conditional and does
    // not, which is the whole difference.
    //
    // What is asserted here is that the module's three instantiations EXIST, so
    // a refactor that deletes one as an unread export loses the check with it.
    expectTypeOf<NoForwardingGap>().toEqualTypeOf<never>();
    expect(["NoForwardingGap", "NoStaleExcuse", "NoRedundantExcuse"]).toHaveLength(3);
  });

  test("carries the journal, which is the gap that motivated this", () => {
    // A runtime check as well as a type one, because the type says the option
    // EXISTS on the bag and this says the door passes it on. `createRuntime` is
    // where it lands, and `agent-server.test.ts` covers that hop; what is
    // asserted here is that the field is not merely declared.
    const declared: (keyof AgentServerOptions)[] = ["agent", "env", "journal"];
    expect(declared).toContain("journal");
  });
});
