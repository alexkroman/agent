// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai console` — talk to the agent through this machine's microphone and
 * speakers, with the conversation printed in the terminal. No server, no
 * browser, no socket.
 *
 * It is the smallest real consumer of `runtime.connect`: the agent is loaded
 * exactly as `aai dev` loads it (same bundle, same `.env` resolution, same
 * shell-credential fallback), a runtime is built in-process, and the session
 * runs over a {@link ClientSink} that plays audio and prints transcripts. Every
 * behaviour a browser session has — turn-taking, barge-in, tools, pacing —
 * comes from the runtime, not from here.
 */

import { styleText } from "node:util";
import {
  createRuntime,
  ensureSessionStateSchema,
  ensureWorkflowJournalSchema,
  type Logger,
  withHostCredentialFallback,
} from "@alexkroman1/aai-runtime";
import pTimeout from "p-timeout";
import { createWorkerEvaluator } from "./_bundler.ts";
import { soxAudio } from "./_console-audio.ts";
import {
  type ConsoleAudio,
  type ConsolePrinter,
  createConsoleSink,
  createSampleAligner,
} from "./_console-session.ts";
import { loadWorker, resolveAgentEnv } from "./_dev-server.ts";
import { type CommandResult, fail, type OutputMode, ok } from "./_output.ts";
import { log } from "./_ui.ts";
import { errorDetail, errorMessage } from "./_utils.ts";

type ConsoleData = { sessionId: string };

/**
 * The pacing lead for a speaker on this machine, in ms.
 *
 * Well under the browser's `CLIENT_AUDIO_LEAD_MS` (1500), because what that
 * lead buys — riding out a lossy network — does not exist between a process
 * and its own sound card, while what it costs does: audio already handed to
 * the device is audio a barge-in has to kill the player to discard.
 */
const CONSOLE_AUDIO_LEAD_MS = 400;

/**
 * How long to wait for the microphone's first bytes before opening the speaker
 * anyway, in ms. Measured on AirPods: 0.74 s. Past this the speaker opens
 * regardless — a slow mic is a possibly-wrong rate, a hang is certainly wrong.
 */
const MIC_OPEN_TIMEOUT_MS = 3000;

/** The runtime's own lines go to stderr, and its chatty ones only when asked. */
function consoleRuntimeLogger(verbose: boolean): Logger {
  const write = (msg: string, ctx?: Record<string, unknown>): void => {
    process.stderr.write(
      `${styleText("dim", msg)}${ctx === undefined ? "" : ` ${styleText("dim", JSON.stringify(ctx))}`}\n`,
    );
  };
  const quiet = (): void => undefined;
  return {
    info: verbose ? write : quiet,
    debug: verbose ? write : quiet,
    warn: write,
    error: write,
  };
}

/** Print the conversation to stdout. */
export function terminalPrinter(write: (line: string) => void): ConsolePrinter {
  return {
    user: (text) => write(`${styleText(["bold", "cyan"], "you   ")} ${text}`),
    agent: (text, interrupted) =>
      write(
        `${styleText(["bold", "green"], "agent ")} ${text}${interrupted ? styleText("dim", " [interrupted]") : ""}`,
      ),
    tool: (name, args) => write(styleText("dim", `      → ${name}(${JSON.stringify(args)})`)),
    error: (message, fatal) =>
      write(
        styleText(fatal ? "red" : "yellow", `      ${fatal ? "error" : "warning"}: ${message}`),
      ),
  };
}

/**
 * Run one console session until Ctrl-C, or until the session ends itself.
 *
 * `audio` is a parameter so the spec can drive it without a sound card.
 */
export async function executeConsole(opts: {
  cwd: string;
  verbose?: boolean | undefined;
  /**
   * JSON mode owes stdout exactly one result line, and JSON mode is
   * auto-selected on a pipe — so there the conversation goes to stderr.
   */
  mode?: OutputMode;
  audio?: ConsoleAudio;
  /** Resolves when the user asks to quit. Defaults to the first SIGINT/SIGTERM. */
  untilQuit?: Promise<void>;
}): Promise<CommandResult<ConsoleData>> {
  const audio = opts.audio ?? soxAudio;
  const logger = consoleRuntimeLogger(opts.verbose === true);

  log.step("Bundling agent…");
  let agentDef: Awaited<ReturnType<typeof loadWorker>>;
  try {
    agentDef = await loadWorker(opts.cwd, createWorkerEvaluator());
  } catch (err) {
    return fail("build_failed", `Could not load agent.ts: ${errorMessage(err)}`);
  }
  if (agentDef.page === "static") {
    return fail(
      "not_a_voice_agent",
      'This agent declares `page: "static"` — a workflow app has no voice session to talk to.',
      "Run `aai dev` and open the page instead.",
    );
  }
  const env = await resolveAgentEnv(opts.cwd, agentDef);
  // The same reason `aai dev` does this: a project with a DATABASE_URL keeps
  // session state there, and nothing else in a local run creates the tables.
  if (env.DATABASE_URL) {
    await ensureSessionStateSchema({ url: env.DATABASE_URL, logger });
    await ensureWorkflowJournalSchema({ url: env.DATABASE_URL, logger });
  }

  const runtime = createRuntime({
    agent: agentDef,
    env,
    providerEnv: withHostCredentialFallback(env),
    logger,
  });
  const { sampleRate, ttsSampleRate } = runtime.readyConfig;

  // A device failing (no SoX, no microphone permission) ends the session: a
  // console with no ears or no mouth is not a degraded console, it is a hang.
  let deviceError: Error | undefined;
  let endNow: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    endNow = resolve;
  });
  const onDeviceError = (err: Error): void => {
    deviceError ??= err;
    endNow();
  };

  // The MICROPHONE opens first, and the speaker only once it is delivering.
  // Opening a Bluetooth headset's mic drops it from its 48 kHz stereo profile
  // into the low-rate headset one, and SoX fixes its output rate when it opens
  // the device — so a speaker opened first keeps resampling for 48 kHz into a
  // device now running at 24: every word at half speed, an octave down.
  // Measured on AirPods: 9.72 s to play a 4.56 s greeting speaker-first,
  // 4.69 s mic-first. Audio before the connection exists is dropped; the
  // greeting waits on `audio_ready` below, so nobody has spoken yet.
  let forward: (bytes: Uint8Array) => void = () => undefined;
  let micOpened: () => void = () => undefined;
  const micReady = new Promise<void>((resolve) => {
    micOpened = resolve;
  });
  const capture = audio.startCapture(
    sampleRate,
    (bytes) => {
      micOpened();
      forward(bytes);
    },
    onDeviceError,
  );
  await pTimeout(Promise.race([micReady, ended]), {
    milliseconds: MIC_OPEN_TIMEOUT_MS,
    fallback: () => undefined,
  });

  const player = audio.startPlayback(ttsSampleRate, onDeviceError);
  const out = opts.mode === "json" ? process.stderr : process.stdout;
  const print = terminalPrinter((line) => out.write(`${line}\n`));
  let closedReason: string | undefined;
  let fatalMessage: string | undefined;
  const sink = createConsoleSink({
    player,
    print,
    onClosed: (reason) => {
      closedReason = reason;
      endNow();
    },
    onFatal: (message) => {
      fatalMessage ??= message;
      endNow();
    },
  });

  const connection = runtime.connect(sink, {
    audioLeadMs: CONSOLE_AUDIO_LEAD_MS,
    logContext: { transport: "console" },
  });
  forward = createSampleAligner(connection);
  // The microphone is live and the speaker is open, which is exactly what the
  // browser client means by `audio_ready` — and it is what releases the greeting.
  connection.sendCommand({ type: "audio_ready" });

  log.success(`Talking to ${agentDef.name}. Press Ctrl-C to hang up.`);
  log.info("Use headphones: without echo cancellation the agent hears itself and interrupts.");

  const quit = opts.untilQuit === undefined ? signalled() : undefined;
  try {
    await Promise.race([opts.untilQuit ?? quit?.signal, ended, connection.ended]);
  } finally {
    // Off on EVERY exit from the wait, not only a signalled one. Left installed
    // after the session ends on its own, they would swallow the Ctrl-C a
    // developer presses while teardown below is still draining.
    quit?.dispose();
  }

  capture.stop();
  connection.close();
  await connection.ended;
  player.stop();
  try {
    await runtime.shutdown();
  } catch (err) {
    logger.warn(`Runtime shutdown failed: ${errorDetail(err)}`);
  }

  if (deviceError) return fail("audio_device", deviceError.message);
  if (fatalMessage !== undefined) return fail("session_failed", fatalMessage);
  if (closedReason === "session start failed") {
    return fail("session_failed", "The session failed to start — see the error above.");
  }
  return ok({ sessionId: connection.id });
}

/** The first SIGINT or SIGTERM, and a way to stop listening for it. */
function signalled(): { signal: Promise<void>; dispose: () => void } {
  let dispose: () => void = () => undefined;
  const signal = new Promise<void>((resolve) => {
    const done = (): void => {
      dispose();
      resolve();
    };
    dispose = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
    };
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
  return { signal, dispose };
}
