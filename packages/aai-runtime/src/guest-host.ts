// Copyright 2026 the AAI authors. MIT license.
/**
 * The host-facing surface an agent BUNDLE hands the guest harness.
 *
 * A deployed agent runs the runtime it was built and tested against: the worker
 * bundle inlines this package and exports `__aaiCreateRuntime` over it
 * (`packages/aai-guest/CLAUDE.md`, "User-shipped runtime"). The harness carries
 * NO copy of its own, so everything it needs from a runtime besides the session
 * factory — the server shell, the workflow delivery door, tracing, the session
 * gate — has to come from that same copy. This is that list, attached to the
 * factory as `__aaiCreateRuntime.host` by the CLI's worker wrapper.
 *
 * It is a TYPED CONTRACT rather than module identity: the harness reads the
 * fields it names off the bundle's export and nothing else, so the guest and an
 * agent bundle built from another SDK version agree on exactly this shape.
 * {@link GUEST_HOST_VERSION} is what a harness checks before it reads a field;
 * bump it when a field is removed or changes meaning, and add fields freely.
 *
 * @module
 */

import {
  agentServerEnv,
  createRuntimeServer,
  createSessionAuth,
  platformSessionSecret,
  SESSION_SECRET_ENV,
  verifySessionToken,
} from "./server/index.ts";
import { startTracingDetached } from "./tracing.ts";
import { handleWorkflowRequest, publishWorkflowWebhookUrl } from "./workflow/serve.ts";

/**
 * The contract version a harness checks.
 *
 * @internal
 */
export const GUEST_HOST_VERSION = 1;

/**
 * Everything the guest harness drives the agent through, from the bundle's copy
 * of this package. See the module doc.
 *
 * @internal
 */
export interface GuestHost {
  readonly version: typeof GUEST_HOST_VERSION;
  /** The HTTP/session shell (`/health`, `/client-config`, `/websocket`, `/workflows/*`). */
  readonly createRuntimeServer: typeof createRuntimeServer;
  /** The agent env minus what a deployed agent must never set (`AAI_ALLOW_HOST`). */
  readonly agentServerEnv: typeof agentServerEnv;
  /** The platform's workflow delivery door, behind `/manage`. */
  readonly handleWorkflowRequest: typeof handleWorkflowRequest;
  /** Publish (or clear) how a step mints this run's public callback URL. */
  readonly publishWorkflowWebhookUrl: typeof publishWorkflowWebhookUrl;
  /** Span and metric export, when an operator configured a collector. */
  readonly startTracingDetached: typeof startTracingDetached;
  /** The session gate: the platform's derived key and the author's own. */
  readonly createSessionAuth: typeof createSessionAuth;
  readonly verifySessionToken: typeof verifySessionToken;
  readonly platformSessionSecret: typeof platformSessionSecret;
  readonly SESSION_SECRET_ENV: typeof SESSION_SECRET_ENV;
}

/**
 * This copy's {@link GuestHost} — what the worker wrapper attaches.
 *
 * @internal
 */
export const GUEST_HOST: GuestHost = Object.freeze({
  version: GUEST_HOST_VERSION,
  createRuntimeServer,
  agentServerEnv,
  handleWorkflowRequest,
  publishWorkflowWebhookUrl,
  startTracingDetached,
  createSessionAuth,
  verifySessionToken,
  platformSessionSecret,
  SESSION_SECRET_ENV,
});
