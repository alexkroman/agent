// Copyright 2026 the AAI authors. MIT license.
/**
 * `stepNotifyClient()` — reach a device when no session is open.
 *
 * A voice session exists only while somebody is talking. A run started from a
 * tool — a reminder parked on `ctx.sleep`, a job that takes an hour — wakes up
 * long after the session that started it closed, and `ctx.send` went with it.
 * So a client that wants to be told things later (a smart speaker, a kiosk)
 * holds a second, IDLE socket open on the agent's own server: `WS /inbox`,
 * named by `?client=<id>`. This is how a step pushes to it.
 *
 * ## The run is the outbox
 *
 * There is no queue behind this. It resolves when the client ACKS the notice,
 * and anything else — the client is not connected, it answered "busy" because
 * someone is mid-question, the ack never came — is a
 * {@link ClientUnreachableError}, which is a `RetryableError`: the step's own
 * retry schedule is the redelivery loop, and the run's durability is the
 * outbox's. A reminder that is due while the speaker is unplugged is delivered
 * when it comes back, through a restart of the agent, for as long as the step's
 * `maxAttempts` allows — so size that for the outage you want to ride out.
 *
 * Delivery is AT-LEAST-ONCE: an ack lost on the way back is a second delivery
 * of the same `id`, and the client drops a repeat. Use something that
 * identifies the delivery, not the attempt — the run id is the usual choice.
 *
 * ## The wire, for whoever writes the client
 *
 * The frames are declared once, as `InboxServerFrame` and `InboxClientFrame`
 * (with their Zod schemas) on `@alexkroman1/aai/protocol`; both the server and
 * `aai-ui`'s client are typed against them. In outline:
 *
 * ```text
 * server -> client  text    {"type":"notice","id","event","data"?,"bytes":N}
 *                   binary  N bytes of `audio`, in frames of at most 4 KiB
 * client -> server  text    {"type":"ack","id"}   have it (also for a repeat)
 *                           {"type":"busy","id"}  not now; try again later
 * ```
 *
 * One notice is in flight per client at a time, so a client never holds more
 * than the one it is handling. The server pings; a client that stops answering
 * is dropped, and its next connection replaces any socket the server still holds
 * for the same id.
 *
 * ## Why a global slot
 *
 * The same reason as {@link stepWebhookUrl}: the sockets live in the server
 * (`aai-runtime`'s `client-inbox.ts`) and the step runs from the agent bundle's
 * own copy of this module. An unpublished slot THROWS a `FatalError` — there is
 * no inbox to wait for, and retrying would only wait longer to say so.
 *
 * @module
 */

import { globalSlot } from "./_boundary.ts";
import { FatalError, RetryableError } from "./step-error-classes.ts";

const STEP_NOTIFY_CLIENT_SLOT = globalSlot<ClientNotifier>("stepNotifyClient");

/**
 * What a client id may look like: it is a map key on a public endpoint and a
 * query parameter on two routes, so it is deliberately narrow.
 *
 * @internal
 */
export const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** One thing to tell a client. */
export type ClientNotice = {
  /**
   * Identifies the DELIVERY, so a client can drop a repeat — the run id, when a
   * run sends one notice. At most 128 characters.
   */
  id: string;
  /** What the client should do with it, e.g. `"reminder"`. */
  event: string;
  /** Anything JSON-serializable the client reads alongside `event`. */
  data?: unknown;
  /**
   * Bytes sent after the header as binary frames — audio the client plays, most
   * often (`stepSpeak`'s `pcm`, at a rate the client expects).
   */
  audio?: Uint8Array;
};

/** Options for {@link stepNotifyClient}. */
export type StepNotifyClientOptions = {
  /**
   * How long to wait for the ack once the notice is sent. It covers the client
   * TAKING it — reading the audio, for one that acks after queueing it — not the
   * whole playback. Default {@link DEFAULT_CLIENT_ACK_TIMEOUT_MS}.
   */
  ackTimeoutMs?: number;
  /**
   * When the next attempt runs after the client was unreachable. Default
   * {@link DEFAULT_CLIENT_RETRY_MS}.
   */
  retryAfterMs?: number;
  signal?: AbortSignal;
};

/** Default {@link StepNotifyClientOptions.ackTimeoutMs}. */
export const DEFAULT_CLIENT_ACK_TIMEOUT_MS = 30_000;
/** Default {@link StepNotifyClientOptions.retryAfterMs}. */
export const DEFAULT_CLIENT_RETRY_MS = 30_000;

/** Why a notice was not taken. */
export type ClientUnreachableReason = "offline" | "busy" | "no-ack" | "disconnected";

/**
 * The client did not take the notice. Retryable: throw it (or let it
 * propagate) and the step runs again after `retryAfter`.
 */
export class ClientUnreachableError extends RetryableError {
  readonly reason: ClientUnreachableReason;
  readonly clientId: string;

  constructor(clientId: string, reason: ClientUnreachableReason, retryAfterMs: number) {
    super(`client "${clientId}" did not take the notice: ${REASONS[reason]}`, {
      retryAfter: retryAfterMs,
    });
    this.name = "ClientUnreachableError";
    this.reason = reason;
    this.clientId = clientId;
  }
}

const REASONS: Record<ClientUnreachableReason, string> = {
  offline: "it has no inbox socket open",
  busy: "it answered busy",
  "no-ack": "it did not ack in time",
  disconnected: "its socket closed before the ack",
};

/**
 * What the host publishes: send one notice and settle when the client answers,
 * with `"acked"` or why it was not taken. It RESOLVES either way rather than
 * throwing a class: the host and the agent bundle hold two copies of this module,
 * and an `instanceof` across them is always false.
 *
 * @internal
 */
export type ClientNotifier = (
  clientId: string,
  notice: ClientNotice,
  options: { ackTimeoutMs: number; signal?: AbortSignal | undefined },
) => Promise<"acked" | ClientUnreachableReason>;

/**
 * What {@link stepNotifyClient} throws when no server published an inbox.
 *
 * @internal
 */
export const CLIENT_INBOX_UNAVAILABLE_MESSAGE =
  "This process has no client inbox, so a step cannot reach a device. It is served by " +
  "createRuntimeServer (aai dev, aai start, a self-hosted server) at WS /inbox. " +
  "In a test, publish a notifier of your own with `publishClientNotifier`.";

/**
 * Publish how this process delivers a notice. `undefined` unpublishes.
 *
 * @internal — a host concern. A step author calls {@link stepNotifyClient}.
 */
export function publishClientNotifier(notify: ClientNotifier | undefined): void {
  STEP_NOTIFY_CLIENT_SLOT.set(notify);
}

/**
 * Push `notice` to the client connected to this agent's `WS /inbox` as
 * `clientId`, and resolve once it acks.
 *
 * Throws {@link ClientUnreachableError} (retryable) when the client is not
 * connected, is busy, or does not ack in time — so call it from a step and let
 * the step's retries redeliver:
 *
 * ```ts
 * import type { WorkflowContext } from "@alexkroman1/aai";
 * import { stepNotifyClient, stepSpeak } from "@alexkroman1/aai/step";
 *
 * export async function remindFlow(
 *   input: { clientId: string; text: string; dueAt: number },
 *   ctx: WorkflowContext,
 * ) {
 *   await ctx.sleep("due", new Date(input.dueAt));
 *   const { runId } = ctx;
 *   await ctx.step(
 *     "deliver",
 *     async () => {
 *       const spoken = await stepSpeak(`Reminder: ${input.text}`, { sampleRate: 16_000 });
 *       await stepNotifyClient(input.clientId, { id: runId, event: "reminder", audio: spoken.pcm });
 *     },
 *     { maxAttempts: 120 }, // an hour of 30 s retries
 *   );
 * }
 * ```
 */
export async function stepNotifyClient(
  clientId: string,
  notice: ClientNotice,
  options: StepNotifyClientOptions = {},
): Promise<void> {
  if (!CLIENT_ID_RE.test(clientId)) {
    throw new FatalError(`stepNotifyClient: "${clientId}" is not a client id (${CLIENT_ID_RE})`);
  }
  if (notice.id.length === 0 || notice.id.length > 128) {
    throw new FatalError("stepNotifyClient: `notice.id` must be 1 to 128 characters");
  }
  const notify = STEP_NOTIFY_CLIENT_SLOT.get();
  if (!notify) throw new FatalError(CLIENT_INBOX_UNAVAILABLE_MESSAGE);
  const retryAfterMs = options.retryAfterMs ?? DEFAULT_CLIENT_RETRY_MS;
  const outcome = await notify(clientId, notice, {
    ackTimeoutMs: options.ackTimeoutMs ?? DEFAULT_CLIENT_ACK_TIMEOUT_MS,
    signal: options.signal,
  });
  if (outcome !== "acked") throw new ClientUnreachableError(clientId, outcome, retryAfterMs);
}
