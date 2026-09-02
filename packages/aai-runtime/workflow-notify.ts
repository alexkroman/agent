// Copyright 2026 the AAI authors. MIT license.
/**
 * Telling the caller a durable run has finished — the half a voice agent was
 * missing.
 *
 * `research-desk` is the worked example and it is where the gap was visible:
 * a tool starts a run, the agent says "I'll let you know as soon as there's an
 * update", and then it never does. The run finishes, the answer exists, and the
 * only way to hear it is for the caller to think to ask again. "I'll let you
 * know" was a promise the SDK gave an author no way to keep.
 *
 * So a tool asks for it at the point it starts the work:
 *
 * ```ts no-check
 * await ctx.workflows.start(research, { topic }, { key: ctx.sessionId, notify: true });
 * ```
 *
 * ## Why a WATCHER and not a callback
 *
 * A run is durable and the process that started it is not. There is no
 * completion hook to register that would survive the guest exiting, so nothing
 * here pretends to be one: this watches for as long as the SESSION is alive and
 * stops the moment it is not. That is the honest scope — an announcement is
 * only meaningful while somebody is on the line — and it is why a run that
 * outlives the call is still found the way it always was, by correlation key on
 * the next call.
 *
 * ## The poll is SHARED, which is what made it cheap
 *
 * This module used to argue the poll was cheap because it ran inside the guest,
 * next to the world the run lives in. On a deployed agent every read is a
 * `POST /:slug/workflow-journal`, and a run worth announcing is usually a run
 * somebody is also WATCHING — a page open on the same run, at a tighter
 * interval, in the same process. So the watch goes through
 * `workflow-run-reads.ts`: {@link RUN_NOTIFY_POLL_MS} is the longest this is
 * willing to wait, not a read of its own, and a run already being streamed
 * costs this watcher nothing at all.
 *
 * ## What the agent is told
 *
 * A synthetic user message — an INSTRUCTION, not a script. The model writes the
 * sentence, because it is the one thing here that knows what the caller already
 * heard and how this agent talks; a canned "your research is done" would be
 * both out of voice and, after a minute of conversation, often out of place.
 */

import { capToolResult } from "@alexkroman1/aai/internal";
import { errorMessage } from "@alexkroman1/aai/utils";
import type { WorkflowClient, WorkflowRunSnapshot } from "@alexkroman1/aai/workflow-api";
import { isTerminal } from "@alexkroman1/aai/workflow-api";
import type { Logger } from "./runtime-config.ts";
import { isRunWatchClosed, type RunWatch, watchRun } from "./workflow-run-reads.ts";

/**
 * How long a watched run may go unread.
 *
 * Sized against what is being watched rather than against the poll's cost: the
 * runs worth announcing take minutes (research three model calls deep, a
 * sixty-segment transcription), so a caller cannot tell two seconds of latency
 * from none. It is the loosest of the three watchers' deadlines, which means a
 * run anybody else is watching is read on their schedule and this one pays for
 * nothing.
 */
export const RUN_NOTIFY_POLL_MS = 2000;

/**
 * Longest a single watch runs before it gives up.
 *
 * A backstop, not a policy: the watch normally ends when the run reaches a
 * terminal status or the session goes away, and both are checked every poll.
 * What this bounds is the case neither covers — a run that never settles in a
 * session that never ends — so it is generous, and giving up is silent because
 * there is nothing a caller could do about it.
 */
export const RUN_NOTIFY_MAX_MS = 30 * 60_000;

/** What a notifier needs from the runtime to reach one live session. */
export type SessionAnnouncer = {
  /**
   * Speak to that session, or report that it cannot be spoken to.
   *
   * FALSE covers three different things on purpose — no such session, a
   * stopped one, and a transport with no injected-turn verb (S2S) — because a
   * watcher's response to all three is the same: stop watching.
   */
  announce(sessionId: string, instruction: string): boolean;
};

/** One request to be told about a run. */
export type WatchRequest = {
  sessionId: string;
  runId: string;
  /**
   * What the agent should do when it lands — an author's sentence, or
   * `undefined` for the default one.
   */
  instruction?: string | undefined;
};

/** Watches runs and announces them. */
export type RunNotifier = {
  /** Start watching one run. Watching the same run twice is a no-op. */
  watch(request: WatchRequest): void;
  /** Stop every watch — process teardown. */
  stop(): void;
  /** How many runs are being watched. For specs and for a log line. */
  readonly size: number;
};

/** Options for {@link createRunNotifier}. */
export type RunNotifierOptions = {
  /** Read runs with the same client `ctx.workflows` is. */
  client: Pick<WorkflowClient, "get">;
  announcer: SessionAnnouncer;
  logger: Logger;
  /** Poll interval. Tests pass a small one; nothing else should. */
  pollMs?: number | undefined;
  /** Give-up deadline. Tests pass a small one. */
  maxMs?: number | undefined;
};

/**
 * Build the notifier one runtime uses.
 *
 * @internal
 */
export function createRunNotifier(opts: RunNotifierOptions): RunNotifier {
  const pollMs = opts.pollMs ?? RUN_NOTIFY_POLL_MS;
  const maxMs = opts.maxMs ?? RUN_NOTIFY_MAX_MS;
  // Keyed by run AND session: the same run legitimately reaches two sessions
  // (a caller who redialled), and only the pair identifies one announcement.
  const watching = new Set<string>();
  // The live handles, so `stop()` can leave the shared reads rather than let
  // each watch notice on its next observation: a teardown that takes one more
  // read per watched run is a teardown that reads a database on the way out.
  const watches = new Set<RunWatch>();
  let stopped = false;

  /**
   * Hold for this run's next shared observation, then decide whether to keep
   * watching.
   *
   * Its own function so {@link poll} is the deadline loop and nothing else.
   */
  async function observe(request: WatchRequest, watch: RunWatch): Promise<"wait" | "stop"> {
    let run: WorkflowRunSnapshot | undefined;
    try {
      // The WAIT and the read in one: this is the interval, which is why there
      // is no `sleep` here any more. A watcher of the same run with a tighter
      // deadline pulls the observation in; nothing pushes it out.
      run = await watch.next(pollMs);
    } catch (err: unknown) {
      if (stopped || isRunWatchClosed(err)) return "stop";
      // A transient read failure is not a reason to abandon a run somebody is
      // waiting on — the next poll is two seconds away.
      opts.logger.debug?.("Workflow notify read failed", {
        runId: request.runId,
        error: errorMessage(err),
      });
      return "wait";
    }
    if (stopped) return "stop";
    // A run that has GONE (a redeployed agent on a fresh database) is not
    // coming back, and announcing nothing is the right answer.
    if (!run) return "stop";
    if (!isTerminal(run)) return "wait";
    announce(request, run);
    return "stop";
  }

  async function poll(request: WatchRequest): Promise<void> {
    const deadline = Date.now() + maxMs;
    const watch = watchRun(opts.client, request.runId);
    watches.add(watch);
    try {
      while (!stopped && Date.now() < deadline) {
        if ((await observe(request, watch)) === "stop") return;
      }
    } finally {
      watches.delete(watch);
      watch.close();
    }
  }

  function announce(request: WatchRequest, run: WorkflowRunSnapshot): void {
    const spoke = opts.announcer.announce(request.sessionId, instructionFor(request, run));
    opts.logger.info("Workflow run announced", {
      sid: request.sessionId,
      runId: request.runId,
      // Read off the RUN rather than carried in: `WorkflowRunBase.workflow` is
      // the declared name, which is what a caller would recognize, and taking
      // it from here means the watcher needs no name resolution of its own
      // (`start` accepts a definition as well as a name).
      workflow: run.workflow,
      status: run.status,
      // Logged rather than swallowed: on an S2S agent this is false for every
      // run, and an author whose agent never speaks up needs the reason to be
      // findable rather than inferred from silence.
      spoke,
    });
  }

  return {
    watch(request: WatchRequest): void {
      if (stopped) return;
      // `\u0000` as the ESCAPE, never a raw NUL byte. A literal one works
      // identically at runtime and makes this file BINARY to `git grep`, which
      // is what every text-scanning gate here runs on — so the whole module
      // stops being scanned, silently. That is not hypothetical: it hid a sixth
      // hand-rolled `sleep` in this very file from guard-invariants rule 19.
      const key = `${request.sessionId}\u0000${request.runId}`;
      if (watching.has(key)) return;
      watching.add(key);
      void poll(request).finally(() => watching.delete(key));
    },
    stop(): void {
      stopped = true;
      watching.clear();
      for (const watch of watches) watch.close();
      watches.clear();
    },
    get size(): number {
      return watching.size;
    },
  };
}

/**
 * What the agent is asked to do when a run lands.
 *
 * An instruction rather than a line to read: the model owns the wording, and it
 * is the only thing here that knows what the caller has already been told. The
 * output is QUOTED (capped) because the agent has no other way to see it — the
 * run finished outside any turn, so nothing put it in the conversation.
 *
 * @internal
 */
export function instructionFor(request: WatchRequest, run: WorkflowRunSnapshot): string {
  const name = run.workflow;
  const lead =
    request.instruction ??
    "Tell the caller the result now, briefly and in your own words, without repeating " +
      "what they already heard.";
  if (run.status === "completed") {
    return (
      `The "${name}" work you started has finished. ${lead}\n\n` +
      `Result: ${capToolResult(JSON.stringify(run.output ?? null))}`
    );
  }
  if (run.status === "failed") {
    return (
      `The "${name}" work you started FAILED: ${run.error}. ` +
      "Tell the caller briefly, apologize once, and offer to try again."
    );
  }
  // Cancelled — somebody stopped it, so the caller may already know. Saying so
  // once is still better than the agent silently dropping a promise it made.
  return (
    `The "${name}" work you started was cancelled before it finished. ` +
    "Mention it briefly and ask whether they want it started again."
  );
}
