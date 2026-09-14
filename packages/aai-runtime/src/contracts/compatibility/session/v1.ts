// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen embedding template: `aai-runtime:session` epoch 1.
 *
 * Driving ONE live session — taking the object the runtime hands back, feeding
 * it a caller's audio and commands, and reading its event stream back out —
 * written the way a host wrote it at epoch 1. It must keep compiling for as
 * long as that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 1 survives it
 *
 * `ServerSession` gained a REQUIRED method at epoch 2: `steerRecognizer`, which
 * biases the recognizer toward words a tool has learned mid-call (a caller's
 * name, an order id) for the rest of the session. A required member is the
 * shape that usually breaks an epoch, and the reason it does not here is the
 * DIRECTION this type travels: a host RECEIVES a `ServerSession` from
 * `Runtime.createSession` and never constructs one — `createSessionCore` is on
 * `@alexkroman1/aai-runtime/internal` and is not part of this surface — so
 * adding a member is a widening for every caller. The template below is
 * deliberately written as a consumer for exactly that reason.
 *
 * **That is also the BOUNDARY of the promise.** Code that IMPLEMENTS
 * `ServerSession` — a hand-written test double standing in for one — has to
 * supply the new method, and epoch 1 does not promise otherwise. A double is
 * the only such implementer this surface admits, since nothing published
 * accepts a caller-supplied session.
 *
 * **Its specifiers are RELATIVE**, like every fixture here: importing the
 * package by name would resolve through its own `exports` map to whatever the
 * current build publishes, so the file would prove the CURRENT surface
 * compiles rather than that epoch 1's does.
 *
 * @module
 */

import type {
  ServerSession,
  SessionEventPage,
  SessionEventStream,
  StoredSessionEvent,
  TransportEventBody,
  TransportEventType,
} from "../../../runtime-barrel.ts";
import { SESSION_EVENTS_TOKEN_ENV } from "../../../runtime-barrel.ts";

/** The token env var a host reads to close `GET /sessions/:id/events`. */
export const eventsToken = (env: Record<string, string>): string | undefined =>
  env[SESSION_EVENTS_TOKEN_ENV];

/**
 * One caller's connection, as a host drives it.
 *
 * Every member touched here is one an epoch-1 host used, and the set is the
 * point: a later epoch that renames `command`, changes what `onAudio` takes,
 * or makes `announce` asynchronous reddens this file.
 */
export class CallBridge {
  // A plain field rather than a parameter property: this package compiles
  // under `erasableSyntaxOnly`, which is the repo's rule and not this
  // fixture's choice.
  private readonly session: ServerSession;

  constructor(session: ServerSession) {
    this.session = session;
  }

  get id(): string {
    return this.session.id;
  }

  /** Did the session fail to open? `faultCode` is how a host finds out. */
  get fault(): string | undefined {
    return this.session.faultCode;
  }

  async open(sampleRate: number): Promise<void> {
    this.session.configure({ audioFormat: "pcm16", sampleRate, ttsSampleRate: sampleRate });
    await this.session.start();
  }

  /** Caller audio, straight through — the hot path, once per frame. */
  audio(bytes: Uint8Array): void {
    this.session.onAudio(bytes);
  }

  /** Everything the CLIENT asks for arrives as one command. */
  interrupt(): void {
    this.session.command({ type: "cancel" });
  }

  /** What the TRANSPORT observed, reported back in the same vocabulary. */
  observed(event: TransportEventBody): void {
    this.session.report(event);
  }

  /** A background run finished and the caller is still on the line. */
  tell(instruction: string): boolean {
    return this.session.announce(instruction);
  }

  async close(): Promise<void> {
    await this.session.stop();
  }
}

/**
 * Read a session's event log back — a page at a time, from a cursor, which is
 * how a host serves a reconnecting client its own history.
 */
export async function drain(
  events: SessionEventStream,
  sessionId: string,
): Promise<readonly SessionEventPage["events"][number][]> {
  await events.hydrate(sessionId);
  const collected: SessionEventPage["events"][number][] = [];
  let cursor = 0;
  for (;;) {
    const page: SessionEventPage = await events.read(sessionId, cursor, 100);
    for (const event of page.events) collected.push(event);
    cursor += page.events.length;
    if (cursor >= page.tail) break;
  }
  await events.flush(sessionId);
  return collected;
}

/**
 * A row as the DURABLE backend holds it, which is a different shape from what
 * `read` answers: the log's own position and the serialized body. A host that
 * queries the table itself rather than the stream reads this one.
 */
export const positionOf = (row: StoredSessionEvent): number => row.index;

/** The event NAMES a host switches on, as a value an epoch-1 host declared. */
export const INTERESTING: readonly TransportEventType[] = [
  "user-transcript.committed",
  "agent-transcript.committed",
];
