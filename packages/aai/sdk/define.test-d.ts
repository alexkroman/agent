// Copyright 2025 the AAI authors. MIT license.
import { expectTypeOf, test } from "vitest";
import { z } from "zod";
import { agent, tool } from "./define.ts";
import type { LlmProvider, SttProvider, TtsProvider } from "./providers.ts";
import type { AgentDef, DefaultSessionState, ToolContext, ToolDef } from "./types.ts";

/**
 * Every `AgentDef` field must be declarable through `agent()`.
 *
 * `AgentParams` is now *derived* from `AgentDef` (Omit + Partial<Pick>), so
 * this holds by construction — the test stays as a regression lock against
 * anyone reintroducing an inline re-declaration, which is how `state` once
 * shipped as a runtime-working but excess-property-error field (the CLI and
 * studio bundlers don't typecheck user code, so nothing caught it).
 */
test("agent() accepts every AgentDef field", () => {
  type MissingFromParam = Exclude<keyof AgentDef, keyof Parameters<typeof agent>[0]>;
  expectTypeOf<MissingFromParam>().toEqualTypeOf<never>();
});

test("agent() infers the state shape from the state factory", () => {
  const def = agent({
    name: "t",
    state: () => ({ count: 0 }),
  });
  // Inferred, not widened to Record<string, unknown> — this is what makes
  // `ctx.state.count` a number in tools rather than `unknown`.
  expectTypeOf(def.state).toEqualTypeOf<(() => { count: number }) | undefined>();
});

test("agent() without a state factory falls back to the permissive default", () => {
  // `any`, so the ordinary unannotated `ctx.state.foo` compiles rather than
  // failing the build gate on correct code. See DefaultSessionState.
  const def = agent({ name: "t" });
  expectTypeOf(def.state).toEqualTypeOf<(() => DefaultSessionState) | undefined>();
});

test("an unannotated tool can read state without a type error", () => {
  // The regression this whole change exists for: `ctx.state.cart` used to be
  // `unknown`, which failed `aai build`'s typecheck on a working agent.
  const add = tool({
    description: "add",
    parameters: z.object({ item: z.string() }),
    execute: ({ item }, ctx) => {
      expectTypeOf(ctx.state).toEqualTypeOf<DefaultSessionState>();
      ctx.state.cart.push(item); // the exact line that used to be TS18046
      return ctx.state.cart.length;
    },
  });
  expectTypeOf(add.description).toEqualTypeOf<string>();
});

test("tool() types ctx.state from an annotated context", () => {
  type Cart = { items: string[] };
  const add = tool({
    description: "add",
    parameters: z.object({ item: z.string() }),
    execute: ({ item }, ctx: ToolContext<Cart>) => {
      expectTypeOf(ctx.state).toEqualTypeOf<Cart>();
      expectTypeOf(item).toEqualTypeOf<string>();
      return ctx.state.items.length;
    },
  });
  expectTypeOf(add).toMatchObjectType<ToolDef<z.ZodObject<{ item: z.ZodString }>, Cart>>();
});

test("a tool expecting a different state shape is not an accepted tool", () => {
  // Asserted as non-assignability rather than as a suppressed type error, so
  // the escape-hatch ratchet stays at its baseline.
  type Cart = { items: string[] };
  type Slot = ToolDef<z.ZodObject<z.ZodRawShape>, Cart>;
  type Mismatched = ToolDef<z.ZodObject<z.ZodRawShape>, { totallyDifferent: number }>;
  expectTypeOf<Mismatched>().not.toExtend<Slot>();
  // ...while a tool that ignores state entirely still fits.
  expectTypeOf<ToolDef<z.ZodObject<z.ZodRawShape>>>().toExtend<Slot>();
});

test("an unannotated tool still composes into a stateful agent", () => {
  // `execute` is declared method-style (bivariant), so a tool written without
  // the state type is not a hard error inside a typed agent — it just sees
  // untyped state. Locking this keeps the generic from becoming viral.
  type Cart = { items: string[] };
  const ping = tool({ description: "p", execute: () => "pong" });
  const def = agent({
    name: "t",
    state: (): Cart => ({ items: [] }),
    tools: { ping },
  });
  expectTypeOf(def.state).toEqualTypeOf<(() => Cart) | undefined>();
});

test("agent() accepts stt/llm/tts optional fields", () => {
  const stt = {} as SttProvider;
  const llm = {} as LlmProvider;
  const tts = {} as TtsProvider;
  const def = agent({ name: "t", systemPrompt: "p", stt, llm, tts });
  expectTypeOf(def.stt).toEqualTypeOf<SttProvider | undefined>();
  expectTypeOf(def.llm).toEqualTypeOf<LlmProvider | undefined>();
  expectTypeOf(def.tts).toEqualTypeOf<TtsProvider | undefined>();
});

test("agent() without stt/llm/tts is still legal (s2s mode)", () => {
  const def = agent({ name: "t", systemPrompt: "p" });
  expectTypeOf(def.stt).toEqualTypeOf<SttProvider | undefined>();
  expectTypeOf(def.llm).toEqualTypeOf<LlmProvider | undefined>();
  expectTypeOf(def.tts).toEqualTypeOf<TtsProvider | undefined>();
});
