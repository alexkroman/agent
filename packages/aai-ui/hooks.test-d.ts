// Copyright 2026 the AAI authors. MIT license.
/**
 * Type-level contract for the four `aai-ui` hooks a custom client is written
 * against. All four are generic, all four are typed BY THE CALLER, and every
 * one of them was unpinned — the root guide claimed `aai-ui` (`.`) had
 * type-level coverage and no `.test-d.ts` existed in this package at all.
 *
 * The reason these need a type test rather than a runtime one: nothing here
 * has runtime behaviour to observe. `useAgentState` is one `useSessionSelector`
 * call plus a cast, and `useToolResult`'s two overloads erase to the same
 * `(...args: unknown[])` implementation. What a consumer actually depends on
 * is the SIGNATURE, and a signature is exactly what a runtime suite cannot
 * assert.
 */

import type { DefaultToolResult } from "@alexkroman1/aai";
import { expectTypeOf, test } from "vitest";
import { useAgentState, useEvent, useToolCallStart, useToolResult } from "./hooks.ts";
import type { ToolCallInfo } from "./types.ts";

type Quote = { symbol: string; price: number };

test("useToolResult passes the caller's type through both overloads", () => {
  // Filtered by tool name: the callback sees the result and the call.
  useToolResult<Quote>("get_quote", (result, toolCall) => {
    expectTypeOf(result).toEqualTypeOf<Quote>();
    expectTypeOf(toolCall).toEqualTypeOf<ToolCallInfo>();
  });

  // Unfiltered: the tool name leads, so a client can switch on it.
  useToolResult<Quote>((name, result, toolCall) => {
    expectTypeOf(name).toEqualTypeOf<string>();
    expectTypeOf(result).toEqualTypeOf<Quote>();
    expectTypeOf(toolCall).toEqualTypeOf<ToolCallInfo>();
  });
});

test("an un-parameterized tool result stays `any`, deliberately", () => {
  // This is the assertion most likely to be "improved" away, so it is the one
  // most worth having. `DefaultToolResult` is `any` on purpose (see its
  // @remarks in aai/sdk/types.ts): a tool result is the author's own return
  // value round-tripped through JSON, so the framework cannot know its shape,
  // and the strict default made reading one field a compile error in a client
  // that runs correctly — which `aai build`'s typecheck then refused to
  // publish. Tightening it to `unknown` is a breaking change for every
  // untyped client, and would fail here rather than in a user's build.
  expectTypeOf<DefaultToolResult>().toBeAny();
  useToolResult("get_quote", (result) => {
    expectTypeOf(result).toBeAny();
  });
});

test("useAgentState returns the caller's projection or null", () => {
  // Nullable on purpose: nothing has been pushed before the first tool call,
  // and a UI has to render that moment.
  expectTypeOf(useAgentState<{ cart: string[] }>()).toEqualTypeOf<{ cart: string[] } | null>();
  expectTypeOf(useAgentState()).toBeAny();
});

test("useAgentState with a fallback drops the null", () => {
  // The whole point of the overload: a client that supplies the empty
  // projection needs no branch for the pre-first-tool-call frame, so the
  // `null` must be gone from the type and not merely unlikely at runtime.
  expectTypeOf(useAgentState<{ cart: string[] }>({ cart: [] })).toEqualTypeOf<{
    cart: string[];
  }>();
});

test("useEvent types the event payload, defaulting to unknown", () => {
  useEvent<Quote>("quote", (data) => {
    expectTypeOf(data).toEqualTypeOf<Quote>();
  });
  // No type argument means `unknown` — NOT `any`. The asymmetry with
  // `useToolResult` above is intentional: an event payload is whatever the
  // tool passed to `ctx.send(event, data)`, which is declared `unknown` on the
  // sending side too, so there is no author-known shape being hidden.
  useEvent("quote", (data) => {
    expectTypeOf(data).toEqualTypeOf<unknown>();
  });
});

test("useToolCallStart carries the call through both overloads", () => {
  useToolCallStart("get_quote", (toolCall) => {
    expectTypeOf(toolCall).toEqualTypeOf<ToolCallInfo>();
  });
  useToolCallStart((toolCall) => {
    expectTypeOf(toolCall).toEqualTypeOf<ToolCallInfo>();
  });
});

test("a tool call's args are `any`, for the same reason results are", () => {
  useToolCallStart("fetch_json", (toolCall) => {
    expectTypeOf(toolCall.args.url).toBeAny();
    expectTypeOf(toolCall.callId).toEqualTypeOf<string>();
    expectTypeOf(toolCall.name).toEqualTypeOf<string>();
  });
});
