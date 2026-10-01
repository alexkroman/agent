// Copyright 2026 the AAI authors. MIT license.
/**
 * The bundle/runtime boundary: every key two copies of this SDK meet on.
 *
 * ## Why there are two copies, and why that is not being fixed by externalizing
 *
 * An agent bundle INLINES `@alexkroman1/aai` (and, for a deploy build, the
 * runtime — `__aaiCreateRuntime`, "User-shipped runtime" in
 * `packages/aai-guest/CLAUDE.md`), so a deployed agent runs the SDK it was built
 * and tested against, never the platform image's. And four hosts run such a
 * bundle under a runtime of their OWN, with its own copy of this module graph:
 * `aai dev` (`buildWorker({ runtime: false })`, run by the CLI's runtime),
 * `aai start` and every `aai build --target` entry (the deploy artifact, run by
 * `createAgentServer` from the project's install), and `aai build` / `aai
 * deploy`, which evaluate the bundle in the CLI for the config preflight.
 * Externalizing the SDK from the bundle would collapse those to one copy only by
 * making the deployed guest supply the SDK — the platform drift the user-shipped
 * runtime exists to rule out — or by making the self-hosted artifact differ from
 * the uploaded one. So two copies in one realm are a property of the design, and
 * this module is the contract between them.
 *
 * ## The contract
 *
 * - **Every cross-copy key is registered here**, in {@link BOUNDARY_KEYS}: the
 *   BRANDS a value carries out of one copy and another copy reads, and the
 *   SLOTS on `globalThis` a host publishes into and the bundle's copy reads.
 *   `Symbol.for` is called in this file and nowhere else in the SDK, and no
 *   other source file spells a registered key — `_boundary.test.ts` scans both
 *   this package and `aai-runtime` for it. A typed name, not a string, is what
 *   a caller passes, so a new key cannot be invented at a call site.
 * - **What crosses is plain data, re-validated by the reader.** A brand's value
 *   is read through {@link readBrand} as `unknown`, and each reader checks its
 *   shape (`clientToolBrand`, `readRouteResponse`, `readRouteError`,
 *   `FatalError.is`): a registry symbol is something any code can mint, and a
 *   copy built from another SDK version may have written a different shape.
 * - **Nothing reads module identity across it**: no `instanceof` on an SDK
 *   class, and no module-level `Map`/`WeakMap` written by one copy and read by
 *   the other. What is copy-local by design (a memo, a warn-once set, the slot
 *   collision detector in `_slot-owners.ts`) only ever sees its own copy.
 * - **A key is never renamed** without changing every copy at once; there are
 *   no older bundles to support, but a bundle and the host that runs it are
 *   built separately.
 *
 * The runtime's own `Symbol.for` slots (`app-db.ts`, `workflow/run-*.ts`,
 * `metrics-sink.ts`) are a different seam — two copies of `aai-runtime`, not of
 * the SDK — and are not registered here.
 *
 * @module _boundary
 * @internal
 */

import { isRecord } from "./is-record.ts";

/**
 * Every key that crosses the bundle/runtime boundary, by the name callers use.
 *
 * Every key is prefixed with the package that owns it, so a second SDK copy
 * shares it rather than shadowing it and nothing else in the process collides.
 *
 * @internal
 */
export const BOUNDARY_KEYS = {
  /** Properties a value carries out of the copy that made it. */
  brands: {
    /** `clientTool()`'s brand on a `ToolDef`: `{ timeoutMs }`. */
    clientTool: "@alexkroman1/aai.clientTool",
    /** The per-call wait the runtime binds on a `ToolContext`: a function. */
    clientToolCall: "@alexkroman1/aai.clientTool.call",
    /** `routeResponse()`'s mark: `true`. */
    routeResponse: "@alexkroman1/aai.routeResponse",
    /** `RouteError`'s mark: `true`. */
    routeError: "@alexkroman1/aai.routeError",
    /** `FatalError` / `RetryableError`: `"fatal" | "retryable"`. */
    stepError: "@alexkroman1/aai.stepError",
    /** `stubSpeech`'s mark on a synthesizer that needs no key: `true`. */
    keylessSynthesizer: "@alexkroman1/aai.speechSynthesizer.keyless",
  },
  /** Values a host publishes on `globalThis` for the bundle's copy to read. */
  slots: {
    channelOutbox: "@alexkroman1/aai.channelOutbox",
    clientEventFeed: "@alexkroman1/aai-runtime.clientEventFeed",
    clientInboxDefaults: "@alexkroman1/aai.clientInboxDefaults",
    clientTranscriptReader: "@alexkroman1/aai.clientTranscriptReader",
    sessionCalls: "@alexkroman1/aai.sessionCalls",
    sessionClients: "@alexkroman1/aai.sessionClients",
    sessionEnders: "@alexkroman1/aai.sessionEnders",
    sessionLocations: "@alexkroman1/aai.sessionLocations",
    sessionPhones: "@alexkroman1/aai.sessionPhones",
    speechSynthesizer: "@alexkroman1/aai.speechSynthesizer",
    stepDelegate: "@alexkroman1/aai.stepDelegate",
    stepEnv: "@alexkroman1/aai.stepEnv",
    stepFetch: "@alexkroman1/aai.stepFetch",
    stepInfoReader: "@alexkroman1/aai.stepInfoReader",
    stepMcp: "@alexkroman1/aai.stepMcp",
    stepNotifyClient: "@alexkroman1/aai.stepNotifyClient",
    stepReporter: "@alexkroman1/aai.stepReporter",
    stepWebhookUrl: "@alexkroman1/aai.stepWebhookUrl",
    uploadReader: "@alexkroman1/aai.uploadReader",
  },
} as const;

/** A registered brand's name. @internal */
export type BrandName = keyof typeof BOUNDARY_KEYS.brands;

/** A registered slot's name. @internal */
export type SlotName = keyof typeof BOUNDARY_KEYS.slots;

/**
 * The registry symbol behind a brand — the same value in every copy.
 *
 * @internal
 */
export function brandSymbol(name: BrandName): symbol {
  return Symbol.for(BOUNDARY_KEYS.brands[name]);
}

/**
 * Put a brand on `target`. Non-enumerable unless asked, so it never reaches a
 * JSON body, a spread or a log line; `configurable` so a subclass (or a second
 * brand call) may restate it.
 *
 * @internal
 */
export function setBrand(
  target: object,
  name: BrandName,
  value: unknown,
  options: { enumerable?: boolean } = {},
): void {
  Object.defineProperty(target, brandSymbol(name), {
    value,
    enumerable: options.enumerable === true,
    configurable: true,
  });
}

/**
 * shape (see the module doc). `undefined` for anything that is not a record or
 * shape (see the module doc). `undefined` for anything that is not an object or
 * a function (an array included), or carries no such brand.
 *
 * @internal
 */
export function readBrand(value: unknown, name: BrandName): unknown {
  if (typeof value !== "function" && !isRecord(value)) return undefined;
  return Reflect.get(value, brandSymbol(name));
}

/**
 * A handle on one process-wide slot. `set(undefined)` deletes the property
 * rather than storing `undefined`, so an unpublished slot is absent, not blank.
 *
 * @internal
 */
export type GlobalSlot<T> = {
  get(): T | undefined;
  set(value: T | undefined): void;
};

/**
 * The registered slot `name`, on `globalThis` under its registry symbol.
 *
 * @internal
 */
export function globalSlot<T>(name: SlotName): GlobalSlot<T> {
  const symbol = Symbol.for(BOUNDARY_KEYS.slots[name]);
  return {
    get: () => Reflect.get(globalThis, symbol) as T | undefined,
    set: (value) => {
      if (value === undefined) Reflect.deleteProperty(globalThis, symbol);
      else Reflect.set(globalThis, symbol, value);
    },
  };
}
