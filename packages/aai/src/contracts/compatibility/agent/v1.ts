// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 1.
 *
 * Epoch 2 widened `llm` from `LlmProvider | string` to name the gateway model
 * union, so a model id autocompletes and a typo is a compile error. The arm
 * that keeps THIS file compiling is `string & Record<never, never>`: an epoch-1
 * author wrote a bare string, including one this release's union has never
 * heard of, and a model shipped after this build must keep working.
 *
 * That is the whole promise being made here — a widening. If a later epoch
 * narrows `llm` to the union alone, this file reddens, which is the signal to
 * drop the epoch rather than to edit the example.
 */

import { agent } from "@alexkroman1/aai";

// A model id in the union.
export const known = agent({
  name: "Known",
  systemPrompt: "Be brief.",
  voice: "michael",
  llm: "claude-sonnet-4-6",
});

// A model id shipped after this release — the case the string arm exists for.
export const future = agent({
  name: "Future",
  systemPrompt: "Be brief.",
  llm: "some-provider/some-model-shipped-later",
});

// The descriptor path, which the string form desugars into.
export const text = agent({ name: "Text", systemPrompt: "Be brief.", text: true });
