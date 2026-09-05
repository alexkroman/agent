// Copyright 2026 the AAI authors. MIT license.
/**
 * A `LanguageModel` that loads its `@ai-sdk/*` package on first use.
 *
 * The STT and TTS halves of provider resolution have loaded lazily since
 * `lazyOpener` (see `resolve.ts`); the LLM half did not, because its registry
 * entry hands back a `LanguageModel` SYNCHRONOUSLY and `resolveLlm` is a
 * published sync function. So `_llm-registry.ts` imported all six
 * `@ai-sdk/*` packages at module load, `resolve.ts` imports that registry
 * statically, and `runtime-barrel.ts` re-exports `resolve.ts` — which put six
 * vendor packages on the import path of every server replica, sandbox host,
 * `aai dev` start and `aai` CLI invocation, for an agent that uses at most one.
 *
 * Measured on the BUILT package, with `ai` already loaded (the runtime needs it
 * either way, so it is not part of the saving): importing
 * `@alexkroman1/aai-runtime` cost 351 ms, and 253 ms with the six providers and
 * `postgres` pre-warmed. ~98 ms of a 393 ms cold import, ~25%.
 *
 * The deferral is a WRAPPER rather than an async `create`, because making
 * `LlmRegistryEntry.create` return a promise is a breaking change to a
 * published extension point (`registerLlmKind`) and to `resolveLlm`, and every
 * caller of both — the pipeline, the model cache, the text agent, the eval
 * stub — would have to become async to buy 98 ms.
 *
 * `specificationVersion`, `provider` and `modelId` are the three members a
 * caller can read without awaiting, so they are declared here rather than
 * forwarded. `provider` is the vendor's own id string (`anthropic.messages`,
 * `openai.responses`, …) and is therefore a hand-copied constant — the one
 * thing in this module that can silently drift. `_lazy-model.test.ts` pins
 * every built-in kind against its eagerly-constructed twin, so a vendor
 * renaming its provider id fails the suite instead of quietly changing what
 * lands in telemetry.
 */

import type { LanguageModel } from "ai";

/**
 * The `LanguageModel` shape this module defers — the current spec version,
 * narrowed out of `ai`'s own union rather than imported from
 * `@ai-sdk/provider`. That package is a transitive of `ai` and declaring it
 * here would put a second copy of the spec types on this package's resolution,
 * free to drift from the one `ai` actually type-checks against. Extracting the
 * member keeps one source and adds no dependency; it also tracks a bump to
 * `v5` by failing here rather than everywhere.
 */
export type DeferredModel = Extract<LanguageModel, { specificationVersion: "v4" }>;

/**
 * Wrap a not-yet-loaded model.
 *
 * `build` is called at most once and its result memoized, so a model resolved
 * up front and used across many turns loads its vendor package one time. The
 * promise itself is cached rather than the resolved model: two concurrent first
 * calls must not both import.
 */
export function lazyModel(
  provider: string,
  modelId: string,
  build: () => Promise<DeferredModel>,
): DeferredModel {
  let pending: Promise<DeferredModel> | undefined;
  const load = (): Promise<DeferredModel> => {
    pending ??= build();
    return pending;
  };
  return {
    specificationVersion: "v4",
    provider,
    modelId,
    // A `PromiseLike` is a legal `supportedUrls` (see the spec type), which is
    // what lets this member defer too. Read as a getter so merely holding the
    // model does not start the import — `streamText` awaits it per call.
    get supportedUrls() {
      return load().then((m) => m.supportedUrls);
    },
    async doGenerate(options) {
      return (await load()).doGenerate(options);
    },
    async doStream(options) {
      return (await load()).doStream(options);
    },
  };
}
