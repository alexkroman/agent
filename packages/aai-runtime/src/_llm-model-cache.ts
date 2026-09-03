// Copyright 2026 the AAI authors. MIT license.
/**
 * The descriptor → `LanguageModel` memo `createGenerateFn` and
 * `createSubagentRunner` both keep.
 *
 * Two capabilities, one mechanism: a descriptor is a plain object declared at
 * module scope, so the SAME object comes back on every call and a `WeakMap`
 * keyed on it reuses one provider client for the life of a session — while
 * holding nothing alive once the agent definition goes away, which a `Map` keyed
 * on a serialized kind would not.
 *
 * Split out because the two copies were verbatim apart from the sentence each
 * throws, and that sentence is the half that legitimately differs: one is
 * telling an author how to configure `ctx.generate`, the other how to configure
 * a named subagent. The guard is shared, the message is the caller's.
 */

import type { ProviderEnv } from "@alexkroman1/aai/host-internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import { isRecord } from "@alexkroman1/aai/utils";
import type { LanguageModel } from "ai";
import { resolveLlm } from "./providers/resolve.ts";

/**
 * Is this a provider descriptor?
 *
 * `isRecord` plus a `kind` check, and `isRecord(undefined)` is already false —
 * so a caller passing a possibly-unset descriptor needs no truthiness guard in
 * front of it.
 */
export function isLlmDescriptor(value: unknown): value is LlmProvider {
  return isRecord(value) && typeof value.kind === "string";
}

/**
 * A resolver that builds each descriptor's model once.
 *
 * The caller checks {@link isLlmDescriptor} first and throws its own message
 * when it fails; this takes the narrowed descriptor and nothing else, so the
 * memo cannot be reached with a value it would key on `undefined`.
 */
export function createLlmModelCache(env: ProviderEnv): (descriptor: LlmProvider) => LanguageModel {
  const models = new WeakMap<LlmProvider, LanguageModel>();
  return (descriptor) => {
    const cached = models.get(descriptor);
    if (cached) return cached;
    const model = resolveLlm(descriptor, env);
    models.set(descriptor, model);
    return model;
  };
}
