// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai console`'s session wiring, with the audio devices abstracted away.
 *
 * The console is a {@link ClientSink} for `runtime.connect` — the same seam any
 * embedder uses to run a session over its own audio I/O — and nothing more. It
 * speaks no protocol and opens no socket: the session writes events and agent
 * audio to the sink, and the microphone is fed straight into the connection.
 *
 * The devices are a {@link ConsoleAudio} so this module is testable without a
 * sound card; `_console-audio.ts` is the SoX implementation the command uses.
 */

import type { SessionEvent } from "@alexkroman1/aai";
import type { ClientSink } from "@alexkroman1/aai/protocol";
import type { SessionConnection } from "@alexkroman1/aai-runtime";

/** A running speaker: PCM16LE mono at the rate it was opened with. */
export type ConsolePlayer = {
  write(pcm16: Uint8Array): void;
  /**
   * Drop whatever the device has not played yet. The runtime's pacer already
   * discards what it is still holding on a barge-in; this is the part that
   * already left it.
   */
  flush(): void;
  stop(): void;
};

/** A running microphone. */
export type ConsoleCapture = { stop(): void };

/** The two audio devices the console needs. */
export type ConsoleAudio = {
  /** Start the microphone, delivering PCM16LE mono chunks at `sampleRate`. */
  startCapture(
    sampleRate: number,
    onChunk: (pcm16: Uint8Array) => void,
    onError: (err: Error) => void,
  ): ConsoleCapture;
  /** Open the speaker at `sampleRate`. */
  startPlayback(sampleRate: number, onError: (err: Error) => void): ConsolePlayer;
};

/** Where the console prints a line of conversation. */
export type ConsolePrinter = {
  user(text: string): void;
  agent(text: string, interrupted?: boolean): void;
  tool(name: string, args: Record<string, unknown>): void;
  error(message: string, fatal: boolean): void;
};

/**
 * The sink the session writes to: agent audio to the speaker, the transcript
 * to the terminal.
 *
 * `onClosed` fires when the RUNTIME closes the sink — a session that failed to
 * start, or one resumed elsewhere — so the command can stop the devices and
 * exit rather than sit with a live microphone feeding nothing.
 *
 * `onFatal` fires on a FATAL `error.reported`, which the protocol defines as
 * "the session is over". A browser shows the banner and the person hangs up;
 * the telephony bridge ends the call; the console has to end itself too, or a
 * session that can never speak (a provider refusing the key) leaves the
 * developer talking to silence.
 */
export function createConsoleSink(opts: {
  player: ConsolePlayer;
  print: ConsolePrinter;
  onClosed: (reason?: string) => void;
  onFatal: (message: string) => void;
}): ClientSink {
  const { player, print } = opts;
  let open = true;
  /** The reply's text so far — what to print if it is cut off before it commits. */
  let pendingAgentText = "";
  return {
    get open() {
      return open;
    },
    event(e: SessionEvent) {
      switch (e.type) {
        case "user-transcript.committed":
          if (e.text.trim()) print.user(e.text);
          return;
        case "agent-transcript.updated":
          pendingAgentText = e.text;
          return;
        case "agent-transcript.committed":
          pendingAgentText = "";
          if (e.text.trim()) print.agent(e.text);
          return;
        case "reply.cancelled":
          // The caller barged in. What was queued on the device is a reply
          // nobody is listening to any more.
          player.flush();
          if (pendingAgentText.trim()) print.agent(pendingAgentText, true);
          pendingAgentText = "";
          return;
        case "session.reset":
          player.flush();
          pendingAgentText = "";
          return;
        case "tool.called":
          print.tool(e.toolName, e.args);
          return;
        case "error.reported":
          print.error(e.message, e.fatal);
          if (e.fatal) opts.onFatal(e.message);
          return;
        default:
          return;
      }
    },
    playAudioChunk(chunk) {
      player.write(chunk);
    },
    close(reason) {
      if (!open) return;
      open = false;
      opts.onClosed(reason);
    },
  };
}

/**
 * Feed a byte stream into a connection as whole PCM16 samples.
 *
 * A pipe hands over reads of whatever length it likes, and an odd one would
 * split a sample across two chunks — every sample after it would then be read
 * with its bytes swapped, which is loud noise rather than a subtle error.
 */
export function createSampleAligner(
  connection: Pick<SessionConnection, "sendAudio">,
): (bytes: Uint8Array) => void {
  let carry: number | null = null;
  return (bytes) => {
    if (bytes.byteLength === 0) return;
    let data = bytes;
    if (carry !== null) {
      const joined = new Uint8Array(bytes.byteLength + 1);
      joined[0] = carry;
      joined.set(bytes, 1);
      data = joined;
      carry = null;
    }
    const whole = data.byteLength - (data.byteLength % 2);
    if (whole < data.byteLength) carry = data[data.byteLength - 1] ?? null;
    if (whole > 0) connection.sendAudio(data.subarray(0, whole));
  };
}
