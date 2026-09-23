// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai console`'s audio devices, as two SoX subprocesses.
 *
 * SoX rather than a native addon: `rec` and `play` open the system's DEFAULT
 * input and output on macOS (CoreAudio), Linux (ALSA/PulseAudio) and Windows
 * with one command line, and a subprocess costs this package no install-time
 * build step and no binary per platform. The price is that SoX must be
 * installed, which {@link missingSoxMessage} says in so many words.
 *
 * Both run in raw PCM16LE mono (`-t raw -b 16 -e signed-integer -c 1 -L`),
 * the format the session speaks, at the rate the session announced.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { ConsoleAudio, ConsoleCapture, ConsolePlayer } from "./_console-session.ts";

const RAW_PCM16 = ["-t", "raw", "-b", "16", "-e", "signed-integer", "-c", "1", "-L"];

/** What to tell a developer whose machine has no SoX. */
export function missingSoxMessage(binary: string): string {
  return (
    `\`aai console\` needs SoX for microphone and speaker access, and \`${binary}\` was not found. ` +
    "Install it (macOS: `brew install sox`; Debian/Ubuntu: `sudo apt install sox`; " +
    "Windows: https://sourceforge.net/projects/sox/) and try again."
  );
}

function spawnError(binary: string, err: NodeJS.ErrnoException): Error {
  return err.code === "ENOENT" ? new Error(missingSoxMessage(binary)) : err;
}

function kill(child: ChildProcess, signal?: NodeJS.Signals): void {
  if (child.exitCode === null && !child.killed) child.kill(signal);
}

/**
 * Spawn `play` so that its stdin is a real PIPE.
 *
 * libuv backs `stdio: "pipe"` with a socketpair, and SoX treats a socket stdin
 * with no bytes ready as end of input: the moment the device drains — the end
 * of the greeting, i.e. the first time the agent stops talking — `play` exits
 * 0 with its stdin still open. Measured on macOS with SoX 14.4.2: a 100 ms gap
 * is enough. A shell pipe does not do it, so bash puts one in between.
 * The `exec` makes the PID we hold `play` itself, so kills and exit codes
 * are its own; the `cat` exits on EOF once Node closes the socket at exit.
 *
 * Windows keeps the direct spawn: it has no bash, and its stdio pipes are
 * named pipes rather than sockets.
 */
function spawnPlay(args: string[]): ChildProcess {
  const stdio: ["pipe", "ignore", "ignore"] = ["pipe", "ignore", "ignore"];
  if (process.platform === "win32") return spawn("play", args, { stdio });
  return spawn("bash", ["-c", 'exec play "$@" < <(exec cat)', "play", ...args], { stdio });
}

/** bash's exit status for a command it could not find — the spawn's ENOENT, one shell down. */
const COMMAND_NOT_FOUND = 127;

/** Open the default microphone. */
function startCapture(
  sampleRate: number,
  onChunk: (pcm16: Uint8Array) => void,
  onError: (err: Error) => void,
): ConsoleCapture {
  // `-q`: no progress meter on stderr. `-` as the output file is stdout.
  const child = spawn("rec", ["-q", ...RAW_PCM16, "-r", String(sampleRate), "-"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let stopped = false;
  child.on("error", (err) => onError(spawnError("rec", err)));
  child.stdout?.on("data", (chunk: Buffer) => {
    onChunk(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  });
  child.on("exit", (code) => {
    if (!stopped && code !== 0 && code !== null) {
      onError(new Error(`the microphone process exited with code ${code}`));
    }
  });
  return {
    stop() {
      stopped = true;
      kill(child);
    },
  };
}

/**
 * Open the default speaker.
 *
 * `flush` KILLS the process and opens a new one, because that is the only way
 * to empty what SoX and the device already hold: there is no "discard buffer"
 * verb on a pipe. The respawn costs a few tens of ms of device open, paid only
 * on a barge-in, when the agent has just stopped talking anyway.
 *
 * The kill is a SIGKILL. SoX traps SIGTERM and only looks at the flag
 * between reads, so a `play` blocked on an idle pipe — every moment the agent
 * is not talking — ignores it and outlives the console.
 */
function startPlayback(sampleRate: number, onError: (err: Error) => void): ConsolePlayer {
  let stopped = false;
  let child = open();

  function open(): ChildProcess {
    const next = spawnPlay(["-q", ...RAW_PCM16, "-r", String(sampleRate), "-"]);
    next.on("error", (err) => onError(spawnError("play", err)));
    // A speaker that dies on its own — the device refused the rate, or was
    // unplugged — ends the console exactly as a dead microphone does. The
    // player we killed ourselves (a flush or a stop) is no longer `child`, or
    // is stopped, so its exit is expected and says nothing.
    next.on("exit", (code) => {
      if (stopped || next !== child) return;
      if (code === COMMAND_NOT_FOUND) return onError(new Error(missingSoxMessage("play")));
      onError(new Error(`the speaker process exited${code === null ? "" : ` with code ${code}`}`));
    });
    // A write racing a flush's kill lands on a closed pipe; that is the flush
    // working, not a failure worth reporting.
    next.stdin?.on("error", () => undefined);
    return next;
  }

  return {
    write(pcm16) {
      if (stopped) return;
      child.stdin?.write(pcm16);
    },
    flush() {
      if (stopped) return;
      const old = child;
      child = open();
      kill(old, "SIGKILL");
    },
    stop() {
      stopped = true;
      child.stdin?.end();
      kill(child, "SIGKILL");
    },
  };
}

/** The SoX-backed devices. */
export const soxAudio: ConsoleAudio = { startCapture, startPlayback };
