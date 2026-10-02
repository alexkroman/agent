// Copyright 2026 the AAI authors. MIT license.
/**
 * Limits enforced in the guest harness. One definition so the guest and any
 * host-side mirror cannot drift.
 *
 * This file is bundled into the guest, so its dependencies are restricted to
 * what the harness bundle already contains: `@alexkroman1/aai` subpaths, and
 * nothing else. Anything the SDK already defines is therefore RE-EXPORTED from
 * it rather than mirrored and asserted (see `limits.test.ts`) — the workspace
 * caps from `@alexkroman1/aai/workspace-files`, the tool deadline from
 * `@alexkroman1/aai/internal`, both of which tsdown bundles in. What is left
 * declared here is what the SDK has no counterpart for. A dependency on `@alexkroman1/aai-cli` — which the
 * harness build keeps EXTERNAL — or on any other package would break guest
 * bundling, which is what `limits.test.ts` guards.
 */

/**
 * Wall-clock cap for a single `run_code` execution, enforced in the guest (the
 * only place `run_code` runs — see SANDBOX_ONLY_BUILTINS). This is the sole
 * definition; the SDK has no host-side counterpart.
 *
 * Enforced by TERMINATING the worker thread the code runs in, not by racing a
 * promise: model-authored code with no `await` in it never yields, so a timer
 * in the same thread can never fire. See `runCode` in `trial.ts` for the wedge
 * that taught us the difference.
 */
export const RUN_CODE_TIMEOUT_MS = 5000;

/**
 * Wall-clock cap for a single guest tool execution. RE-EXPORTED rather than
 * mirrored: `@alexkroman1/aai/internal` is a subpath tsdown already bundles
 * (`harness.ts` imports it), so the caps' argument applies here too and one
 * definition beats a copy held in step by an assertion.
 */
export { TOOL_EXECUTION_TIMEOUT_MS as TOOL_TIMEOUT_MS } from "@alexkroman1/aai/internal";

/**
 * How long the guest harness tolerates having no host WebSocket connected
 * before concluding it is orphaned and exiting. The connection itself is the
 * liveness signal: a host that dies without teardown (crash, OOM, SIGKILL
 * past the drain deadline) drops the socket, and the harness must not keep
 * its Modal sandbox alive to the lifetime cap, billing the whole way. The
 * window also covers the boot gap between the harness starting to listen and
 * the host's first dial (pool spawns dial within seconds).
 */
export const HARNESS_ORPHAN_TIMEOUT_MS = 5 * 60_000;

/** Poll cadence of the guest orphan check. */
export const HARNESS_ORPHAN_POLL_MS = 30_000;

/**
 * Version of the AGENT-MODE guest contract: the exec-env boot convention
 * (AAI_GUEST_MODE / AAI_BUNDLE_PATH | AAI_BUNDLE_URL / AAI_BUNDLE_SHA256 /
 * AAI_AGENT_ENV_PATH / AAI_PUBLIC_BASE_URL / AAI_PLATFORM_BASE_URL) plus the
 * token-gated `/manage/*`
 * HTTP surface. Reported
 * by `GET /manage/status`. Agent sandboxes run the harness image PINNED at
 * deploy time, so the host may be newer than this harness — bump this on any
 * change to the surface, and keep host-side consumers tolerant of older
 * versions (additive changes only).
 *
 * v2 added `AAI_BUNDLE_URL` beside `AAI_BUNDLE_PATH` — the guest fetches its
 * own bundle from a signed Storage URL instead of the platform reading it and
 * writing it into the sandbox. The host sends the URL whenever its blob store
 * can sign, and the path otherwise.
 *
 * v3 added `AAI_PUBLIC_BASE_URL` — the agent's own public base URL (origin plus
 * slug), which the harness passes to the bundle's runtime as `publicUrl` so a
 * durable run can mint a webhook URL a third party can actually reach. **It needs
 * no image comparison and no host-side check**, and the difference from v2 is the
 * reason the additive-only rule is worth stating: a v2 harness receiving an
 * unknown exec-env key ignores it and boots exactly as before, where v2's own
 * change replaced one key with another and so could fail a boot. The degraded
 * behaviour on an older pinned guest is that `ctx.workflows.publicWebhookUrl`
 * throws naming the option — the same answer as an unconfigured deployment, and
 * cured by a redeploy.
 *
 * v4 added `AAI_PLATFORM_BASE_URL` — where the PLATFORM is dialable, which v3
 * had made `AAI_PUBLIC_BASE_URL` do as a second job. The two claims can require
 * opposite values: the public one is handed to a third party so it must resolve
 * from the internet, and this one is dialled from inside the sandbox so it must
 * resolve from there. Under the `microsandbox` backend they are different
 * strings, and the guest's own port is the platform's port — so a guest dialling
 * the public value POSTed every platform call to ITSELF and its own 404 handler
 * answered (`POST /<slug>/workflow-storage 404`, and every durable run dead at
 * its first `events.create`). `aai-server/public-origin.ts`'s
 * `agentPlatformBaseUrl` is the derivation and the argument.
 *
 * The bundle's runtime dials `AAI_PLATFORM_BASE_URL` alone; a bundle built
 * before v4 must be redeployed.
 *
 * v5 made `__aaiCreateRuntime.host` REQUIRED on the harness↔bundle handshake —
 * the typed `GuestHost` surface (`aai-runtime/guest-host.ts`) a harness that
 * carries no runtime of its own drives the agent through. It is the bundle side
 * that changed, and the two ends stay paired: a deployed agent runs the harness
 * image pinned at ITS deploy, and that deploy's CLI built its bundle, so an older
 * pinned guest never meets a v5 bundle's field it cannot read (it ignores the
 * extra property) and a v5 harness never boots an older bundle without a redeploy,
 * which rebuilds it. A v5 harness REFUSES a bundle with no host surface at load,
 * naming the rebuild.
 */
export const GUEST_CONTRACT_VERSION = 5;

/**
 * Wall-clock cap on fetching the worker bundle from `AAI_BUNDLE_URL`. Bounded
 * well under the host's own readiness budget (`AGENT_HEALTH_TIMEOUT_MS`, 120s)
 * so a stalled fetch reports ITSELF on stderr rather than surfacing as an
 * anonymous readiness timeout on the host side.
 */
export const BUNDLE_FETCH_TIMEOUT_MS = 60_000;

/**
 * Agent-mode idle self-exit: with zero live sessions for this long the guest
 * exits 0 so Modal's idle timeout reclaims the sandbox. Agent-mode guests
 * have NO host control connection (the server contract is HTTP-only), so the
 * orphan-timeout mechanism cannot apply — and the guest is the ONLY idle
 * reclaimer (the host-side idle sweep was deleted; the guest's exit
 * surfaces host-side as process death → onSandboxLost detaches the slot).
 * Overridable via AAI_GUEST_IDLE_EXIT_MS, which the spawner forwards from
 * the server's own env (`agentBootEnv` in aai-server/warm-harness.ts) — a
 * guest reads only what it is handed at exec, so setting it on the platform
 * process is what reaches every backend. 0 disables.
 */
export const AGENT_IDLE_EXIT_MS = 5 * 60_000;

/** Poll cadence of the agent-mode idle/drain check. */
export const AGENT_IDLE_POLL_MS = 5000;

/**
 * Studio workspace caps. Unlike the constants above — asserted rather than
 * imported so this module stays dependency-free — these are RE-EXPORTED from
 * the SDK, which the harness bundles anyway: they are the same caps the CLI's
 * push and the platform's validation enforce, and three hand-kept copies of a
 * number that must agree is exactly what a mirror costs.
 */
export {
  MAX_WORKSPACE_FILE_BYTES as MAX_STUDIO_FILE_BYTES,
  MAX_WORKSPACE_FILES as MAX_STUDIO_FILES,
} from "@alexkroman1/aai/workspace-files";
