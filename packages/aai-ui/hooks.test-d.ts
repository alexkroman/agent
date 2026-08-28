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

import { type DefaultToolResult, sessionSlot } from "@alexkroman1/aai";
import { expectTypeOf, test } from "vitest";
import type { FormValues } from "./components/form-types.ts";
import { useAgentState, useEvent, useToolCallStart, useToolResult } from "./hooks.ts";
import type { ChatMessage, ToolCallInfo } from "./types.ts";
import { type ConversationItem, useConversation } from "./use-conversation.ts";
import { useDownloadUrl } from "./use-download-url.ts";
import { useWorkflowSubmit } from "./use-workflow-form.ts";

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

test("useAgentState infers its type from a slot projection", () => {
  // The overload's whole reason to exist: the projection's return type IS the
  // state's type, so a caller passing one restates nothing. A type argument
  // here would mean the round-trip is still hand-wired.
  const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));
  const cartProjection = cartSlot.projection((cart) => ({ count: cart.items.length }));

  expectTypeOf(useAgentState(cartProjection)).toEqualTypeOf<{ count: number }>();
  // And the `null` is gone, for the same reason the `fallback` overload drops
  // it: a projection always yields a frame.
  expectTypeOf(useAgentState(cartProjection)).not.toEqualTypeOf<{ count: number } | null>();
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

/**
 * `useConversation`'s item type is a DISCRIMINATED union, and that is the whole
 * ergonomic promise: a custom renderer writes one `kind` check and the other
 * member's field is gone. Widening it to `{ kind: string; message?: … }` — the
 * shape it would take if the two arms were merged for convenience — compiles at
 * every call site and silently makes both fields optional, which is exactly the
 * regression a runtime test cannot see.
 */
test("a conversation item narrows on `kind`, with no optional fields to guard", () => {
  const { items, streaming, transcript, thinking } = useConversation();
  expectTypeOf(items).toEqualTypeOf<readonly ConversationItem[]>();
  // `null` between turns rather than `""`, which is the transcript's convention
  // and deliberately NOT this one — an agent that has said nothing is silent.
  expectTypeOf(streaming).toEqualTypeOf<string | null>();
  expectTypeOf(thinking).toEqualTypeOf<boolean>();
  expectTypeOf(transcript.speaking).toEqualTypeOf<boolean>();
  expectTypeOf(transcript.partial).toEqualTypeOf<string | null>();

  // Extracted rather than narrowed by an `if`: a conditional `expect` is
  // exactly as strong here (both arms are types, not runtime paths) and it is
  // what `noConditionalExpect` asks for.
  type MessageItem = Extract<ConversationItem, { kind: "message" }>;
  type ToolItem = Extract<ConversationItem, { kind: "tool" }>;
  expectTypeOf<MessageItem["message"]>().toEqualTypeOf<ChatMessage>();
  expectTypeOf<ToolItem["toolCall"]>().toEqualTypeOf<ToolCallInfo>();
  // Each arm carries ONE payload field, so a renderer that checked `kind` never
  // has an optional to guard. Widening the union into a single member with two
  // optional fields — the shape a convenience merge produces — fails here.
  expectTypeOf<MessageItem>().not.toHaveProperty("toolCall");
  expectTypeOf<ToolItem>().not.toHaveProperty("message");
});

/**
 * `pending` is REQUIRED and the other two are not, which is the distinction the
 * hook exists to restore: both templates faked it as "neither url nor error",
 * which reads a download in flight and no id at all as the same state.
 */
test("useDownloadUrl reports pending unconditionally and the rest optionally", () => {
  const result = useDownloadUrl(undefined);
  expectTypeOf(result.pending).toEqualTypeOf<boolean>();
  expectTypeOf(result.url).toEqualTypeOf<string | undefined>();
  expectTypeOf(result.error).toEqualTypeOf<string | undefined>();
});

/**
 * The workflow hooks are typed by the DEF, which types BOTH halves.
 *
 * They used to take the output type alone, and the asymmetry was the bug: a
 * page already wrote `WorkflowOutputOf<typeof digest>` for the output while
 * `submit` took `unknown`, so `submit({ ur1: 42 })` compiled and arrived as a
 * 400 in the browser.
 *
 * The DEF-typed half is proved by the six workflow templates, which typecheck
 * against a real `workflow({ input: z.object(…) })` — building one here would
 * need `zod` (not a dependency of this package) or `StandardSchemaV1` (on
 * `/host-internal`, which a browser package may not import). A/B'd on
 * `link-digest`: reintroducing `submit({ ur1: 42 })` fails with `TS2353: 'ur1'
 * does not exist in type '{ url: string; }'`.
 *
 * There is no untyped fallback: the def is REQUIRED, so an un-parameterized
 * call does not compile. That is deliberate — the fallback was the last way to
 * get an untyped `submit` back, and an escape hatch nobody needs is one
 * somebody uses. A workflow that declares no input schema gets `submit(): void`
 * rather than an unusable `never` parameter, which `SubmitInputOf` is what
 * makes true.
 */
test("submitForm is the door for DOM-scraped values, and stays loose on purpose", () => {
  // `FormValues` is `Record<string, unknown>` read off the elements at submit
  // time, so the shape is not knowable here and the SERVER validates it against
  // the workflow's schema. Tightening this would be a lie.
  const submission = useWorkflowSubmit("digest");
  expectTypeOf(submission.submitForm).parameter(0).toEqualTypeOf<FormValues>();
});
