// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 1.
 *
 * Epoch 2 added `StubGenerateRoutes`/`StubGenerateScript` and let
 * `createToolContext` take a script rather than only a function. It also
 * NARROWED one thing: `stubGenerate({ text })` with no `object` no longer
 * compiles, because it was read as a route table keyed by the system prompt
 * `"text"` and rejected every call at runtime.
 *
 * So this example is deliberately the epoch-1 shapes that were CORRECT: a
 * reply carrying `object`, a route table keyed by prompt fragments, and the
 * `stubGenerate` → destructure → `createToolContext` three-step. The misuse is
 * not pinned here and must not be — a promise to keep it compiling would be a
 * promise to keep a runtime failure available.
 */

import { createToolContext, stubGenerate } from "@alexkroman1/aai/testing";

// A single reply. `object` is what told this apart from a route table.
const single = stubGenerate({ text: "A short summary.", object: null });

// A route table, keyed by a fragment of the system prompt.
const routed = stubGenerate({
  summarize: { text: "A short summary.", object: null },
  classify: { text: "billing", object: { label: "billing" } },
});

// The three-step epoch 2 collapses into one call. Both still compile.
export const ctx = createToolContext({ generate: single.generate });
export const routedCtx = createToolContext({ generate: routed.generate });

// The fakes' call logs are the assertion surface, then and now.
export const calls = (): number => single.calls.length + routed.calls.length;
