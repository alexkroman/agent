// Copyright 2026 the AAI authors. MIT license.
/**
 * The fast-check commands for the S2S property test — one per thing that can
 * happen to a live S2S session — and the weighted pools the three properties
 * draw from.
 *
 * The model IS the provider state machine — what the AssemblyAI S2S service is
 * holding for this session — which is what makes `check()` meaningful rather
 * than decorative: no audio outside a reply, no `reply.started` while the
 * service is awaiting a `tool.result`, no `transcript.agent` on a tool-call turn
 * (measured behaviour, see `_s2s-reply.ts`). A generator that emits what no real
 * service would produces findings that cost real time to dismiss, and this is
 * where that is prevented.
 *
 * Each command is one thing that can happen to a live session — a frame the
 * service sends, a socket dying, the client barging in, a tool settling. Legality
 * is `check()`'s job, against the model in `_s2s-fuzz-service.ts`; the weighted
 * pools that draw on them live in `_s2s-fuzz-plans.ts`.
 *
 * Two of them are deliberately COMPOSITE (`ToolTurnAcrossResume`,
 * `CancelThenStrayAudio`). Both assemble frames the state machine would allow
 * individually, and both exist because the ordering they fix is one that uniform
 * picks reach too rarely to conclude anything from — the measurements are in
 * their doc comments.
 *
 * @internal Test infrastructure, not part of any public API.
 */

import type fc from "fast-check";
import { drain, type Harness } from "./_s2s-fuzz-harness.ts";
import { FATAL_CODES, MALFORMED_FRAMES, TRANSIENT_CODES } from "./_s2s-fuzz-model.ts";
import {
  emitDrop,
  emitReady,
  emitReplyDone,
  emitToolCall,
  hit,
  type ServiceModel,
  syncFromReality,
} from "./_s2s-fuzz-service.ts";

export type Cmd = fc.AsyncCommand<ServiceModel, Harness>;

/** Base for a command that delivers one frame on the live socket. */
abstract class FrameCommand implements Cmd {
  abstract check(m: Readonly<ServiceModel>): boolean;
  abstract label(): string;
  protected abstract emit(m: ServiceModel, h: Harness): void;

  async run(m: ServiceModel, h: Harness): Promise<void> {
    const sock = h.link.current();
    // A command whose target vanished is a no-op rather than a failure — but a
    // counted one, so a model that has drifted out of step with the real link
    // shows up as coverage falling rather than as a quietly weaker run.
    if (sock === undefined || sock.dead) hit(h, "skip:noLiveSocket");
    else this.emit(m, h);
    await drain();
    syncFromReality(m, h);
  }

  toString(): string {
    return this.label();
  }
}

/**
 * Answer a handshake — in practice the RESUME handshake, since `createHarness`
 * has already answered the first one.
 */
export class Ready extends FrameCommand {
  private readonly asUpdated: boolean;
  constructor(asUpdated: boolean) {
    super();
    this.asUpdated = asUpdated;
  }
  check(m: Readonly<ServiceModel>): boolean {
    return m.awaitingOpen === false && !m.ready && !m.retired;
  }
  label(): string {
    return `ready(${this.asUpdated ? "session.updated" : "session.ready"})`;
  }
  protected emit(m: ServiceModel, h: Harness): void {
    emitReady(m, h, this.asUpdated);
  }
}

export class OpenSocket implements Cmd {
  check(m: Readonly<ServiceModel>): boolean {
    return m.awaitingOpen;
  }
  async run(m: ServiceModel, h: Harness): Promise<void> {
    h.link.unopened()?.open();
    await drain();
    syncFromReality(m, h);
  }
  toString(): string {
    return "openSocket";
  }
}

export class SpeechStart extends FrameCommand {
  check(m: Readonly<ServiceModel>): boolean {
    return m.ready && !m.speech;
  }
  label(): string {
    return "speech.started";
  }
  protected emit(m: ServiceModel, h: Harness): void {
    m.speech = true;
    h.link.current()?.deliver({ type: "input.speech.started" });
  }
}

export class SpeechStop extends FrameCommand {
  check(m: Readonly<ServiceModel>): boolean {
    return m.ready && m.speech;
  }
  label(): string {
    return "speech.stopped";
  }
  protected emit(m: ServiceModel, h: Harness): void {
    m.speech = false;
    h.link.current()?.deliver({ type: "input.speech.stopped" });
  }
}

export class UserPartial extends FrameCommand {
  check(m: Readonly<ServiceModel>): boolean {
    return m.ready && m.speech;
  }
  label(): string {
    return "transcript.user.delta";
  }
  protected emit(m: ServiceModel, h: Harness): void {
    m.seq++;
    h.link
      .current()
      ?.deliver({ type: "transcript.user.delta", item_id: `it-${m.seq}`, text: "what is th" });
  }
}

export class UserFinal extends FrameCommand {
  check(m: Readonly<ServiceModel>): boolean {
    return m.ready;
  }
  label(): string {
    return "transcript.user";
  }
  protected emit(m: ServiceModel, h: Harness): void {
    m.seq++;
    h.link
      .current()
      ?.deliver({ type: "transcript.user", item_id: `it-${m.seq}`, text: `utterance ${m.seq}` });
  }
}

export class ReplyStart extends FrameCommand {
  check(m: Readonly<ServiceModel>): boolean {
    // The service will not open a new reply while it is awaiting a tool result —
    // the outstanding call IS the turn's continuation point.
    return m.ready && !m.replyInFlight && m.outstanding.size === 0;
  }
  label(): string {
    return "reply.started";
  }
  protected emit(m: ServiceModel, h: Harness): void {
    m.seq++;
    m.replyInFlight = true;
    m.sawToolCall = false;
    m.replyId = `rep-${m.seq}`;
    // A new reply is what lifts the transport's post-cancel audio suppression.
    h.audioSuppressed = false;
    h.link.current()?.deliver({ type: "reply.started", reply_id: `rep-${m.seq}` });
  }
}

export class Audio extends FrameCommand {
  check(m: Readonly<ServiceModel>): boolean {
    return m.ready && m.replyInFlight;
  }
  label(): string {
    return "reply.audio";
  }
  protected emit(_m: ServiceModel, h: Harness): void {
    // Proof the suppression oracle gets a chance: the service is still streaming
    // the reply the client just cancelled.
    if (h.audioSuppressed) hit(h, "audioDuringSuppression");
    h.link.current()?.deliver({ type: "reply.audio", data: "AAECAwQF" });
  }
}

export class AgentText extends FrameCommand {
  check(m: Readonly<ServiceModel>): boolean {
    // Measured: a tool-call turn sends no `transcript.agent` at all.
    return m.ready && m.replyInFlight && !m.sawToolCall;
  }
  label(): string {
    return "transcript.agent";
  }
  protected emit(m: ServiceModel, h: Harness): void {
    m.seq++;
    h.link
      .current()
      ?.deliver({ type: "transcript.agent", text: `the answer is ${m.seq}`, reply_id: "rep" });
  }
}

export class ToolCall extends FrameCommand {
  check(m: Readonly<ServiceModel>): boolean {
    return m.ready && m.replyInFlight;
  }
  label(): string {
    return "tool.call";
  }
  protected emit(m: ServiceModel, h: Harness): void {
    emitToolCall(m, h);
  }
}

/**
 * The targeted scenario, and the reason this suite exists: the service issues a
 * tool call, ends the reply carrying it, the socket dies while the session is
 * still executing the tool, and the session is then RESTORED with that call
 * still unanswered. What happens to the answer from there is what the
 * tool-answer oracle is about.
 *
 * One command rather than five, because reaching this ordering by uniform picks
 * is rare enough to be useless: `dropWithToolInFlight` came in at 2 across 260
 * runs and `toolAnsweredAcrossResume` at 0-1, which is not a number anything can
 * be concluded from. Every step is one the state machine allows individually;
 * only their order is fixed, and what happens NEXT — settle, cancel, another
 * drop, nothing at all — is still the plan's choice.
 */
export class ToolTurnAcrossResume implements Cmd {
  check(m: Readonly<ServiceModel>): boolean {
    return m.ready && m.replyInFlight && m.faultBudget > 0;
  }

  async run(m: ServiceModel, h: Harness): Promise<void> {
    const sock = h.link.current();
    if (sock === undefined || sock.dead) {
      hit(h, "skip:noLiveSocket");
      return;
    }
    emitToolCall(m, h);
    // `m.toolsInFlight` is written ONLY by `syncFromReality`, so without this
    // the count below is the previous command's — read before the session has
    // even seen the `tool.call` just delivered. This composite exists to
    // manufacture exactly the state `drop.withToolInFlight` counts, and that
    // counter is a coverage FLOOR, so grading it on stale state is how a live
    // floor becomes a decorative one.
    await drain();
    syncFromReality(m, h);
    emitReplyDone(m, h, false);
    if (m.toolsInFlight > 0 && m.outstanding.size > 0) hit(h, "drop.withToolInFlight");
    hit(h, "transientDrop");
    emitDrop(m, h, TRANSIENT_CODES[0], "");
    // Let the transport notice the close and start its resume, then bring the
    // replacement socket up and answer its handshake.
    await drain();
    h.link.unopened()?.open();
    await drain();
    emitReady(m, h, false);
    await drain();
    syncFromReality(m, h);
  }

  toString(): string {
    return "toolTurnAcrossResume";
  }
}

export class ReplyDone extends FrameCommand {
  private readonly interrupted: boolean;
  constructor(interrupted: boolean) {
    super();
    this.interrupted = interrupted;
  }
  check(m: Readonly<ServiceModel>): boolean {
    return m.ready && m.replyInFlight;
  }
  label(): string {
    return `reply.done(${this.interrupted ? "interrupted" : "completed"})`;
  }
  protected emit(m: ServiceModel, h: Harness): void {
    emitReplyDone(m, h, this.interrupted);
  }
}

export class SessionError extends FrameCommand {
  private readonly expired: boolean;
  constructor(expired: boolean) {
    super();
    this.expired = expired;
  }
  check(m: Readonly<ServiceModel>): boolean {
    // Legal before the handshake too: `session_not_found` IN ANSWER TO a
    // `session.resume` is exactly the ordering that found the open-socket bug.
    // Only the expiry code is destructive; a rate limit leaves the session up.
    return !m.retired && (!this.expired || m.faultBudget > 0);
  }
  label(): string {
    return `session.error(${this.expired ? "session_not_found" : "rate_limited"})`;
  }
  protected emit(m: ServiceModel, h: Harness): void {
    if (this.expired) m.faultBudget--;
    hit(h, this.expired ? "sessionErrorExpired" : "sessionErrorTransient");
    h.link
      .current()
      ?.deliver(
        this.expired
          ? { type: "session.error", code: "session_not_found", message: "gone" }
          : { type: "session.error", code: "rate_limited", message: "slow down" },
      );
  }
}

export class Malformed extends FrameCommand {
  private readonly index: number;
  constructor(index: number) {
    super();
    this.index = index;
  }
  check(): boolean {
    return true;
  }
  label(): string {
    return `malformed(${this.index})`;
  }
  protected emit(_m: ServiceModel, h: Harness): void {
    hit(h, "malformedDelivered");
    const frame = MALFORMED_FRAMES[this.index % MALFORMED_FRAMES.length];
    const sock = h.link.current();
    if (typeof frame === "string") sock?.deliverRaw(frame);
    else if (frame !== undefined) sock?.deliver(frame);
  }
}

export class Drop extends FrameCommand {
  private readonly transient: boolean;
  private readonly index: number;
  constructor(transient: boolean, index: number) {
    super();
    this.transient = transient;
    this.index = index;
  }
  check(m: Readonly<ServiceModel>): boolean {
    return m.faultBudget > 0;
  }
  label(): string {
    return `drop.${this.transient ? "transient" : "fatal"}(${this.code()})`;
  }
  private code(): number {
    const codes = this.transient ? TRANSIENT_CODES : FATAL_CODES;
    return codes[this.index % codes.length] as number;
  }
  protected emit(m: ServiceModel, h: Harness): void {
    hit(h, this.transient ? "transientDrop" : "fatalDrop");
    // A drop while the session is executing a tool is the state the tool-answer
    // oracle exists for: the answer now has to survive a `session.resume`.
    if (m.toolsInFlight > 0 && m.outstanding.size > 0) hit(h, "drop.withToolInFlight");
    emitDrop(m, h, this.code(), this.transient ? "" : "policy");
  }
}

export class SocketError extends FrameCommand {
  check(m: Readonly<ServiceModel>): boolean {
    return m.faultBudget > 0;
  }
  label(): string {
    return "socket.error";
  }
  protected emit(m: ServiceModel, h: Harness): void {
    const sock = h.link.current();
    sock?.socketError("ECONNRESET");
    emitDrop(m, h, 1006, "");
  }
}

/** Resolve the oldest tool execution the session is holding open. */
export class SettleTool implements Cmd {
  private readonly ok: boolean;
  constructor(ok: boolean) {
    this.ok = ok;
  }
  check(m: Readonly<ServiceModel>): boolean {
    return m.toolsInFlight > 0;
  }
  async run(m: ServiceModel, h: Harness): Promise<void> {
    h.pendingTools[0]?.settle(this.ok);
    await drain();
    syncFromReality(m, h);
  }
  toString(): string {
    return `settleTool(${this.ok ? "ok" : "throws"})`;
  }
}

export class ClientAudio implements Cmd {
  check(): boolean {
    return true;
  }
  async run(m: ServiceModel, h: Harness): Promise<void> {
    h.session.onAudio(new Uint8Array(320));
    await drain();
    syncFromReality(m, h);
  }
  toString(): string {
    return "client.audio";
  }
}

/**
 * Barge-in, and then the audio that was already on the wire for the reply the
 * user just interrupted. AssemblyAI S2S has no cancel RPC, so this is not an
 * edge case — it is what every barge-in looks like, and dropping that audio is
 * the whole job of the transport's `suppressAudioUntilReply`.
 *
 * A composite because the oracle only fires when audio arrives INSIDE the
 * suppression window, and leaving that to two independent picks made it a
 * coin-flip: `audioDuringSuppression` ranged 0-5 across 260 runs, so its floor
 * could not be set at anything meaningful.
 */
export class CancelThenStrayAudio implements Cmd {
  check(m: Readonly<ServiceModel>): boolean {
    return m.ready && m.replyInFlight;
  }

  async run(m: ServiceModel, h: Harness): Promise<void> {
    hit(h, "clientCancel");
    h.audioSuppressed = true;
    h.session.command({ type: "cancel" });
    await drain();
    if (h.audioSuppressed) hit(h, "audioDuringSuppression");
    h.link.current()?.deliver({ type: "reply.audio", data: "AAECAwQF" });
    await drain();
    syncFromReality(m, h);
  }

  toString(): string {
    return "cancel + stray audio";
  }
}

/**
 * Barge-in. Deliberately NOT charged to `faultBudget`: `SessionCore.onCancel`
 * aborts the reply's tools but does NOT replace the reply, so their (error)
 * results still flush on `reply.done` — an S2S provider has no cancel RPC and is
 * still awaiting them. So a cancel does not strand a tool call the way a reset
 * or a drop does.
 */
export class ClientCancel implements Cmd {
  check(): boolean {
    return true;
  }
  async run(m: ServiceModel, h: Harness): Promise<void> {
    hit(h, "clientCancel");
    h.audioSuppressed = true;
    h.session.command({ type: "cancel" });
    await drain();
    syncFromReality(m, h);
  }
  toString(): string {
    return "client.cancel";
  }
}

export class ClientReset implements Cmd {
  check(m: Readonly<ServiceModel>): boolean {
    return m.faultBudget > 0;
  }
  async run(m: ServiceModel, h: Harness): Promise<void> {
    m.faultBudget--;
    hit(h, "clientReset");
    // A reset abandons the conversation, tool calls in flight included — the
    // provider's outstanding calls are the user's to strand.
    for (const id of m.outstanding) h.excused.add(id);
    h.session.command({ type: "reset" });
    await drain();
    syncFromReality(m, h);
  }
  toString(): string {
    return "client.reset";
  }
}
