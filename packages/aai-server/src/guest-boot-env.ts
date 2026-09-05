// Copyright 2026 the AAI authors. MIT license.
/**
 * The BOOT ENV a deployed agent guest is exec'd with — the one place both
 * backends compose it.
 *
 * Split out of `warm-harness.ts` for its line cap, and it is a clean seam
 * rather than an arbitrary cut: everything here answers one question ("what
 * does a guest need handed to it at exec"), and nothing else in that module
 * reads any of it. `warm-harness.ts` re-exports the two names so the spawn
 * sites and the specs are untouched.
 *
 * The RULE this file exists to keep is that a guest inherits NOTHING: every
 * key is composed or explicitly forwarded from the server's own environment.
 * That is what stops agent code which wrongly reads `process.env` working
 * locally and failing in production, and it is what keeps platform
 * credentials out of a tenant container.
 *
 * @module
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { agentPlatformBaseUrl, agentPublicBaseUrl } from "./public-origin.ts";

/**
 * The exec env selecting agent mode and naming the boot artifacts — one
 * builder so the three backends cannot drift on the key names the guest reads
 * (see aai-guest/harness-agent-mode.ts).
 *
 * Every key here is an `AAI_*` boot parameter, and that is now the rule rather
 * than an observation. `TMPDIR` was the exception: it is a property of the
 * CONTAINER, not of agent mode, so it belongs to `guestExecBaseEnv()`
 * (`guest-exec-env.ts`) — which the two contained backends spread over this env
 * and `subprocess` deliberately does not. It was here because that file was one
 * line from its length cap, and the cost was three copies of one value.
 *
 * `AAI_GUEST_IDLE_EXIT_MS` is forwarded from the SERVER's env when set. The
 * guest documents it as the override for its idle self-exit, but the guest
 * reads `process.env` and only the Modal backend's guests have an ambient
 * environment (the image's) to read it from — the subprocess backend builds
 * a minimal env on purpose, so the knob did nothing there and the one
 * lifecycle timer an operator might want to tune was untunable exactly where
 * it is quickest to observe. Forwarding it here is an explicit boot
 * parameter, not env inheritance, so that rule still holds. The guest owns
 * the parse (an unusable value falls back to its default).
 *
 * `AAI_DEBUG` is forwarded the same way, for a sharper version of the same
 * reason: `debugLoggingEnabled` (aai-runtime/runtime-config.ts) is a module-level
 * `const` read from `process.env` at IMPORT time, while a deployed agent's own env
 * arrives as the boot FILE at `AAI_AGENT_ENV_PATH`, parsed into an object that is
 * never merged into `process.env`. So there was NO WAY AT ALL to switch the guest's
 * debug logging on in a deployed guest — and the guest is where the numbers are:
 * `platform-rpc.ts`'s per-call `{ label, route, traceId, status, elapsedMs }` line
 * is the only decomposition of the guest→platform journal RPC anything measures,
 * and it was dead in production by construction. Read it back off the host log
 * (`startGuestLogging` drains both guest streams) or `aai logs`. Three things
 * before reaching for it: it takes effect at guest BOOT ONLY, that flag being read
 * once at module load, so a resident guest must respawn (redeploy, or idle-exit)
 * before the value is read; it is per REPLICA rather than per slug, arming every
 * agent guest this server goes on to spawn; and `AAI_DEBUG` is the one spelling
 * forwarded — not the `LOG_LEVEL=DEBUG` form `debugLoggingEnabled` also accepts,
 * which is a generic name a hosting stack sets for its own reasons and would make
 * the PLATFORM's log level arm per-message logging inside a tenant's guest, and
 * not `AAI_DEBUG_PARTIALS`, off even under `AAI_DEBUG=1` by the runtime's own
 * design so the turn-level lines stay readable. Its absence is a decision.
 *
 * `AAI_UPLOAD_BROKER_URL` carries the same value as `AAI_PUBLIC_BASE_URL` under a
 * second name on purpose — see the comment at its own line for why one key cannot
 * serve both claims.
 *
 * `AAI_PUBLIC_BASE_URL` is the newest key and the first whose consumer is the
 * BUNDLE'S SDK rather than the harness: the harness hands it straight through as
 * `createRuntime`'s `publicUrl`, and `ctx.workflows.publicWebhookUrl` is what
 * reads it. It is derived HERE — the one place both backends share — for the
 * reason the doc's first line gives, and from {@link agentPublicBaseUrl} rather
 * than from the brokering request, because three of the four spawn paths hold no
 * request at all. Absent when this replica can name no origin; the SDK's own
 * throw is then the report.
 */
export function agentBootEnv(
  opts: {
    /**
     * The agent being spawned. Only `AAI_PUBLIC_BASE_URL` reads it — the guest
     * never learns its own slug otherwise, and does not need to.
     */
    slug: string;
    token: string;
    port: number;
    /**
     * Where the bundle is: a path the spawner wrote into the sandbox, or a
     * URL the guest fetches (see {@link WorkerSource}). Exactly one, because
     * the shape decides — there is no precedence rule for the guest to get
     * wrong, and no way to name a path that was never written.
     */
    bundle: { path: string } | { url: string };
    bundleSha256: string;
    envPath: string;
  },
  /** The server's own environment; injectable for tests. */
  serverEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const idleExitMs = serverEnv.AAI_GUEST_IDLE_EXIT_MS?.trim() || undefined;
  const debugLogging = serverEnv.AAI_DEBUG?.trim() || undefined;
  const otel = otelBootEnv(serverEnv);
  const publicBaseUrl = agentPublicBaseUrl(opts.slug, serverEnv);
  const platformBaseUrl = agentPlatformBaseUrl(opts.slug, serverEnv);
  return {
    AAI_GUEST_MODE: "agent",
    AAI_GUEST_TOKEN: opts.token,
    AAI_GUEST_PORT: String(opts.port),
    ...("url" in opts.bundle
      ? { AAI_BUNDLE_URL: opts.bundle.url }
      : { AAI_BUNDLE_PATH: opts.bundle.path }),
    AAI_BUNDLE_SHA256: opts.bundleSha256,
    AAI_AGENT_ENV_PATH: opts.envPath,
    // Blank means "not set", normalized to `undefined` above — so both of these
    // are the `omitUndefined` spelling the three URL keys below argue for, not a
    // truthiness guard (`guard-invariants` rule 22). The idle-exit key was that
    // guard until this module was split out and the ratchet re-read the line.
    ...omitUndefined({ AAI_GUEST_IDLE_EXIT_MS: idleExitMs, AAI_DEBUG: debugLogging }),
    // OMITTED rather than set empty when there is no origin to name: the guest
    // trims and drops a blank anyway, but a key that is present and useless is
    // the shape a `publicUrl: ""` bug takes, and a URL a third party cannot
    // reach must not be minted from one. Through `omitUndefined` rather than a
    // truthiness-guarded spread, which is what these three used to be: none of
    // the builders can return `""` (each is `origin ? `${origin}/${slug}`` or
    // undefined), so the two are equivalent here and only one of them is the
    // spelling guard-invariants rule 22 stops the repo re-deriving.
    //
    // THREE keys at (usually) the same value, and the duplication is the point —
    // each is a different CLAIM, and the guest reads them for different jobs:
    //
    // - `AAI_PUBLIC_BASE_URL` — "third parties reach this agent here". A
    //   self-hosted deployment behind a proxy answers this one too. Read as
    //   `publicUrl`, and minted into a webhook URL somebody else dials.
    // - `AAI_UPLOAD_BROKER_URL` — "the thing at this URL serves my upload
    //   bytes", which only a managed platform can say. Reusing the first would
    //   put a self-hosted agent on a byte route nothing serves and 404 every
    //   upload. See `aai/host/server.ts`'s `uploadBroker`.
    // - `AAI_PLATFORM_BASE_URL` — "the platform is DIALABLE here", read by
    //   `resolvePlatformQueue` for run storage, the queue, session state and
    //   upload records. It is the only one of the three that has to be
    //   resolvable from inside the sandbox, which is why it has its own builder
    //   and its own microVM rewrite — see `agentPlatformBaseUrl`.
    //
    // The first two are DELIBERATELY the same value and the third only usually
    // is: in local dev it is derived from this server's own port instead of an
    // observed origin, so a preview works with nothing configured.
    ...omitUndefined({
      AAI_PUBLIC_BASE_URL: publicBaseUrl,
      AAI_UPLOAD_BROKER_URL: publicBaseUrl,
      AAI_PLATFORM_BASE_URL: platformBaseUrl,
    }),
    ...otel,
  };
}

/**
 * The collector configuration a guest needs to export spans, from the
 * PLATFORM's environment — see `aai-runtime/tracing.ts`.
 *
 * Forwarded explicitly, exactly the `AAI_DEBUG` and `AAI_GUEST_IDLE_EXIT_MS`
 * precedent, so the minimal-env property is untouched: the guest still inherits
 * nothing. That property is load-bearing rather than tidiness — it is what
 * stops agent code that wrongly reads `process.env` working locally and failing
 * in production.
 *
 * **Where the credential lives, and who can read it.**
 * `OTEL_EXPORTER_OTLP_HEADERS` is where an OTLP collector's ingest key goes.
 * These land in the guest's EXEC env, i.e. its `process.env` — which is a
 * different surface from the agent env: `ctx.env` is built from the boot FILE
 * at `AAI_AGENT_ENV_PATH` and `process.env` is never merged into it, so tool
 * code written against the SDK cannot see this. It is NOT hidden from the
 * sandbox, though: it sits beside `AAI_GUEST_TOKEN`, so agent code that reaches
 * around the SDK for `process.env`, or a `run_code` body, can read it. The
 * container is the security boundary and this credential shares the sandbox's
 * trust level, so it must be scoped as one — ingest-only, per deployment,
 * never an account-wide key.
 *
 * The whole set is forwarded verbatim rather than re-derived, because the
 * exporter resolves its own URL and header grammar and a second parse here
 * would be a second answer to a question the library already answers.
 */
function otelBootEnv(serverEnv: NodeJS.ProcessEnv): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const key of OTEL_GUEST_ENV_KEYS) {
    const value = serverEnv[key]?.trim();
    if (value) forwarded[key] = value;
  }
  // All or nothing: without an endpoint the guest's gate is closed, so a
  // stray `OTEL_SERVICE_NAME` alone would be a key that is present and
  // useless — the shape the three URL keys above are omitted to avoid.
  const armed =
    forwarded.OTEL_EXPORTER_OTLP_ENDPOINT ?? forwarded.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  return armed ? forwarded : {};
}

/**
 * The standard OTel variables a guest is given, if the platform has them.
 *
 * Spelled once, and asserted by `warm-harness.test.ts` against the guest's own
 * reader — a key forwarded under a name the guest does not read is a collector
 * that silently receives nothing.
 */
export const OTEL_GUEST_ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_SERVICE_NAME",
] as const;
