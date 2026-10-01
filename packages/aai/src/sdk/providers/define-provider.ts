// Copyright 2026 the AAI authors. MIT license.
/**
 * `defineProvider` — the SDK half of one vendor's registration.
 *
 * A vendor used to be spelled in seven places: a factory here, an opener in
 * `aai-runtime`, an entry in that package's registry, an env-var constant, a
 * row in the providers guide, a row in the docs site's table, and a barrel
 * export. Each was free to disagree with the others, and they did — a provider
 * whose factory, registry and tests were all updated still went unlisted on the
 * docs site.
 *
 * Now each vendor is ONE {@link ProviderDefinition} here, in its own module, and
 * everything that is pure data derives from it:
 *
 * - the factory — {@link describeProvider} stamps the definition's `kind` onto
 *   the options, so the factory cannot name a kind of its own;
 * - the `*_KIND` / `*_API_KEY_ENV` constants on `host-internal`;
 * - `aai-runtime`'s registry entry, whose credential variable is read off the
 *   definition and whose `open` is keyed to it (see `providers/registry.ts`
 *   there, where a type and a spec hold every catalog kind to exactly one
 *   opener);
 * - `requiredProviderEnvVars` and the credential allowlist, which read those
 *   registry entries;
 * - the docs site's provider table, GENERATED from {@link PROVIDER_CATALOG} by
 *   `pnpm sync:provider-table` and held current by `check:provider-table`.
 *
 * The OPENER cannot live here: the SDK must not import a vendor SDK or a line
 * of runtime code, and `aai-runtime` imports this package, never the reverse.
 * So the registration is split along the package boundary and keyed by
 * `(stage, kind)` — this half is data, that half is the `open` — and the
 * completeness check is the join between them.
 *
 * Not authoring API: an author calls the FACTORY. Published on
 * `@alexkroman1/aai/host-internal` for the runtime, the docs generator and the
 * gates.
 *
 * @module
 */

import type { ProviderDescriptor } from "../providers.ts";

/** The four stages a provider can serve. */
export type ProviderStage = "stt" | "llm" | "tts" | "s2s";

/**
 * One vendor at one stage, as data — see the module doc.
 *
 * @internal
 */
export interface ProviderDefinition<
  Kind extends string = string,
  Stage extends ProviderStage = ProviderStage,
> {
  /** The descriptor `kind` the host resolves, unique within its stage. */
  readonly kind: Kind;
  /** Which `agent()` field the descriptor goes in. */
  readonly stage: Stage;
  /**
   * The agent-env variable the vendor's key is read from. `""` for a
   * credential-free provider (a model on the developer's own machine): the
   * preflight then demands nothing, and `apiKeyEnv` still routes one.
   */
  readonly envVar: string;
  /** The vendor's display name, as an error or the docs table prints it. */
  readonly label: string;
  /**
   * How an author spells it, for the docs table: the factory name
   * (`"deepgramStt"`) or, for the one-factory LLM stage, the call
   * (`'llm({ provider: "anthropic" })'`).
   */
  readonly factory: string;
  /** The `@alexkroman1/aai` subpath the factory is imported from. */
  readonly subpath: "stt" | "llm" | "tts" | "s2s" | "experimental";
}

/**
 * Freeze a definition, keeping its `kind` and `stage` LITERAL so a catalog of
 * them yields a closed kind union per stage.
 *
 * @internal
 */
export function defineProvider<const Kind extends string, const Stage extends ProviderStage>(
  definition: ProviderDefinition<Kind, Stage>,
): ProviderDefinition<Kind, Stage> {
  return Object.freeze({ ...definition });
}

/**
 * Build the descriptor a definition's factory returns: its `kind`, plus a
 * shallow COPY of the options so a caller mutating its bag afterwards cannot
 * reach a descriptor already handed to `agent()`.
 *
 * @internal
 */
export function describeProvider<Kind extends string>(
  definition: ProviderDefinition<Kind>,
  options: object,
): ProviderDescriptor<Kind, Record<string, unknown>> {
  return { kind: definition.kind, options: { ...options } };
}
