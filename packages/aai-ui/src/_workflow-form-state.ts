// Copyright 2026 the AAI authors. MIT license.
/**
 * A workflow form's submission as a statechart, with no React: the mount-time
 * lookup, the submission in flight, the person's pause, and what the page is
 * left holding afterwards. `useWorkflowSubmit` and `useWorkflowStream` feed it
 * through `_submission-state.ts`; `_workflow-form-state.test.ts` specs it
 * without a renderer. The pattern is `_tap-to-talk-state.ts`'s and
 * `session/audio-state.ts`'s: a `setup()` machine, effects in `input`,
 * cancellable work as a `fromPromise` invoke.
 *
 * ```text
 *   idle ──RECOVER──► recovering ──found──► following
 *     ▲                   │ └──none──► idle
 *     │                   └──failed──► failed
 *   RESET (anywhere)
 *   SUBMIT (anywhere) ──► submitting { active ⇄ paused } ──done──► following
 *                                                       └─failed─► failed
 * ```
 *
 * It replaces four `useState`s, a `startedHere` flag, a `recovering` flag and
 * a ref holding the live submission, and three rules that were each a patch
 * over a race the position now answers:
 *
 * - **A superseded submission owns nothing.** It used to be dropped by a token
 *   compare in `end()` (`current !== token`). A `SUBMIT` now RE-ENTERS
 *   `submitting`, which stops the old invoke: its signal aborts, which cancels
 *   its gate, and XState drops its result. Reports from it are refused at the
 *   producer, on the same signal — the one "is this still wanted?" test, in the
 *   one place that knows the answer.
 * - **The lookup never wins a race against a submit.** It used to be
 *   `setRunId(current => current ?? found)`. The lookup is an invoke of
 *   `recovering` now, so a `SUBMIT` (or a `RESET`) that leaves it stops it,
 *   and an answer that lands afterwards is an answer nobody asked for.
 * - **`pending` was three hooks' flags OR-ed together.** Two of the three were
 *   positions in this machine; {@link WorkflowFormView.busy} is both. The
 *   third, the run's own `polling`, stays outside on purpose: it is
 *   `useWorkflowRun`'s and cannot be derived from the snapshot (see that hook).
 *
 * ## What `submitting` does not split
 *
 * Uploading and starting are not child states. The two hooks run them in
 * OPPOSITE orders — `useWorkflowSubmit` stores the bytes and then starts the
 * run, `useWorkflowStream` starts the run and then streams the bytes — so a
 * fixed `uploading → starting` order would be wrong for one of them, and
 * nothing this machine decides depends on which step is current. `active` /
 * `paused` is the split that does matter: it is the gate, and the bar's
 * `paused` flag, moving together.
 */

import { errorMessage } from "@alexkroman1/aai";
import { assign, createActor, fromPromise, setup } from "xstate";
import type { UploadGate } from "./upload/index.ts";
import type { UploadStatus } from "./use-workflow-form.ts";

/** What a running submission may report back, while it is still the live one. */
export type SubmissionReports = {
  /** How far the bytes have got; `undefined` takes the bar down. */
  progress: (status: UploadStatus | undefined) => void;
  /** The run exists. `useWorkflowStream` says so before its bytes are in. */
  started: (runId: string) => void;
};

/**
 * One submission's body: the hook's own walk, with its ORDER.
 *
 * Resolving is success and rejecting is the submission's failure. A body that
 * has been superseded or reset keeps running until it unwinds — its gate is
 * cancelled, so it does so promptly — but nothing it reports or throws reaches
 * the machine any more.
 */
export type SubmissionWork = (reports: SubmissionReports) => Promise<void>;

/** What the machine decides and cannot do itself. */
export type WorkflowFormEffects = {
  /** The newest run under the page's key, or `undefined` when it has none. */
  find: () => Promise<string | undefined>;
};

/** Everything that moves the machine. */
export type WorkflowFormEvent =
  /**
   * Start a submission, superseding whatever is in flight. `settle` is called
   * once, as the submission leaves `submitting` by any edge — which is what
   * `submit()`'s promise resolves on.
   */
  | { type: "SUBMIT"; gate: UploadGate; work: SubmissionWork; settle: () => void }
  /** Look up the page's run by key. Taken only while the page shows no run. */
  | { type: "RECOVER" }
  /** Put the form back: abandon the submission or the lookup, drop the result. */
  | { type: "RESET" }
  /** Park the bytes. */
  | { type: "PAUSE" }
  /** Send the rest. */
  | { type: "RESUME" };

/** Raised by the live submission's body, through {@link SubmissionReports}. */
type Report =
  | { type: "PROGRESS"; upload: UploadStatus | undefined }
  | { type: "STARTED"; runId: string };

type Context = {
  effects: WorkflowFormEffects;
  runId: string | undefined;
  startError: string | undefined;
  upload: UploadStatus | undefined;
  startedHere: boolean;
  /** The live submission's gate, body and settle — set by `SUBMIT`, cleared on exit. */
  gate: UploadGate | undefined;
  work: SubmissionWork | undefined;
  settle: (() => void) | undefined;
};

type SubmissionInput = {
  gate: UploadGate | undefined;
  work: SubmissionWork | undefined;
  settle: (() => void) | undefined;
  send: (event: Report) => void;
};

const machine = setup({
  types: {} as {
    context: Context;
    input: WorkflowFormEffects;
    events: WorkflowFormEvent | Report;
  },
  actors: {
    lookup: fromPromise(({ input }: { input: WorkflowFormEffects }) => input.find()),
    /**
     * One submission. An invoke rather than a fire-and-forget call so that
     * leaving `submitting` — a superseding `SUBMIT`, a `RESET`, an unmount —
     * stops it, and stopping it is what abandons it.
     */
    submission: fromPromise(
      async ({ input, signal }: { input: SubmissionInput; signal: AbortSignal }) => {
        const { gate, work, settle, send } = input;
        // Stopped: release the bytes, so the body unwinds instead of uploading
        // for a submission nobody is showing.
        signal.addEventListener("abort", () => gate?.cancel(), { once: true });
        const live = (event: Report): void => {
          if (!signal.aborted) send(event);
        };
        try {
          await work?.({
            progress: (upload) => live({ type: "PROGRESS", upload }),
            started: (runId) => live({ type: "STARTED", runId }),
          });
        } finally {
          // `submitting`'s exit settles every departure the machine makes; this
          // is the one it does not make — the whole machine stopping, which
          // runs no exit actions. Idempotent, so the overlap is harmless.
          if (signal.aborted) settle?.();
        }
      },
    ),
  },
  guards: {
    found: ({ event }) => "output" in event && typeof event.output === "string",
    hasRun: ({ context }) => context.runId !== undefined,
    noRun: ({ context }) => context.runId === undefined,
  },
  actions: {
    open: assign(({ event }) =>
      event.type === "SUBMIT"
        ? {
            gate: event.gate,
            work: event.work,
            settle: event.settle,
            // Before the request rather than when it returns: a finished result
            // under a form that is already submitting again is the one wrong
            // answer this can give, and it looks like a right one.
            runId: undefined,
            startError: undefined,
            upload: undefined,
            startedHere: true,
          }
        : {},
    ),
    /**
     * Leaving `submitting`, by whichever edge. The bar goes too: from here the
     * wait belongs to the RUN, and a bar left at 100% under a running workflow
     * reads as the thing taking the time.
     */
    close: assign({ gate: undefined, work: undefined, settle: undefined, upload: undefined }),
    /**
     * `submit()`'s promise. Before `close`, which forgets it; and before the
     * edge's own actions only in program order — a resolution runs its
     * continuation as a microtask, after the whole transition has landed, so
     * an awaiting caller already reads the error or the run.
     */
    settle: ({ context }) => context.settle?.(),
    clear: assign({ runId: undefined, startError: undefined, startedHere: false }),
    pauseGate: ({ context }) => context.gate?.pause(),
    resumeGate: ({ context }) => context.gate?.resume(),
    /** Folded rather than replaced: which file and how far are still true. */
    markPaused: assign({
      upload: ({ context }) => (context.upload ? { ...context.upload, paused: true } : undefined),
    }),
    markResumed: assign({
      upload: ({ context }) => (context.upload ? { ...context.upload, paused: false } : undefined),
    }),
  },
}).createMachine({
  id: "workflowForm",
  context: ({ input }) => ({
    effects: input,
    runId: undefined,
    startError: undefined,
    upload: undefined,
    startedHere: false,
    gate: undefined,
    work: undefined,
    settle: undefined,
  }),
  initial: "idle",
  on: {
    // From anywhere, and RE-ENTERING when already submitting: re-entry is what
    // stops the superseded submission's invoke.
    SUBMIT: { target: ".submitting", reenter: true, actions: "open" },
    // No error for it — that would be the page reporting the person's own
    // button back to them.
    RESET: { target: ".idle", actions: "clear" },
  },
  states: {
    idle: {
      on: { RECOVER: "recovering" },
    },
    /**
     * The mount-time lookup (`_recover-run.ts`). Leaving by any other edge —
     * a submit, a reset — stops it, so a late answer adopts nothing.
     */
    recovering: {
      entry: assign({ startError: undefined }),
      invoke: {
        src: "lookup",
        input: ({ context }) => context.effects,
        onDone: [
          {
            guard: "found",
            target: "following",
            actions: assign({ runId: ({ event }) => event.output }),
          },
          { target: "idle" },
        ],
        // Reported rather than swallowed: an empty form in front of a live
        // run invites the second run the key exists to prevent.
        onError: {
          target: "failed",
          actions: assign({ startError: ({ event }) => errorMessage(event.error) }),
        },
      },
    },
    submitting: {
      initial: "active",
      exit: ["settle", "close"],
      invoke: {
        src: "submission",
        input: ({ context, self }) => ({
          gate: context.gate,
          work: context.work,
          settle: context.settle,
          send: (event: Report) => {
            self.send(event);
          },
        }),
        onDone: [{ guard: "hasRun", target: "following" }, { target: "idle" }],
        onError: {
          target: "failed",
          actions: assign({ startError: ({ event }) => errorMessage(event.error) }),
        },
      },
      on: {
        PROGRESS: { actions: assign({ upload: ({ event }) => event.upload }) },
        STARTED: { actions: assign({ runId: ({ event }) => event.runId }) },
      },
      states: {
        active: {
          on: { PAUSE: { target: "paused", actions: ["pauseGate", "markPaused"] } },
        },
        paused: {
          on: { RESUME: { target: "active", actions: ["resumeGate", "markResumed"] } },
        },
      },
    },
    /** A run on the page — started here, or adopted by the lookup. */
    following: {},
    /**
     * The submission's or the lookup's own failure. A stream submission can
     * land here WITH a run (started, then its upload failed and it was
     * cancelled), which is why `RECOVER` is guarded rather than plain.
     */
    failed: {
      on: { RECOVER: { guard: "noRun", target: "recovering" } },
    },
  },
});

/** What the hooks render from. A new object only when a field changes. */
export type WorkflowFormView = {
  /** The run on the page, once there is one. */
  runId: string | undefined;
  /** The submission's or the lookup's own failure, as against the run's. */
  startError: string | undefined;
  /** The bar's state, or nothing when there is no upload to describe. */
  upload: UploadStatus | undefined;
  /** Did a `SUBMIT` on this machine produce what is on the page? */
  startedHere: boolean;
  /** Looking up or submitting: the half of `pending` that is this machine's. */
  busy: boolean;
};

/** One running machine: send events, read and subscribe to its view, stop it. */
export type WorkflowFormStore = {
  send(event: WorkflowFormEvent): void;
  getView(): WorkflowFormView;
  subscribe(listener: () => void): () => void;
  stop(): void;
};

/** Start a machine over `effects`. */
export function createWorkflowForm(effects: WorkflowFormEffects): WorkflowFormStore {
  const actor = createActor(machine, { input: effects });
  let view: WorkflowFormView = {
    runId: undefined,
    startError: undefined,
    upload: undefined,
    startedHere: false,
    busy: false,
  };
  const read = (): WorkflowFormView => {
    const at = actor.getSnapshot();
    const { runId, startError, upload, startedHere } = at.context;
    const busy = at.matches("recovering") || at.matches("submitting");
    if (
      runId !== view.runId ||
      startError !== view.startError ||
      upload !== view.upload ||
      startedHere !== view.startedHere ||
      busy !== view.busy
    ) {
      view = { runId, startError, upload, startedHere, busy };
    }
    return view;
  };
  actor.start();
  return {
    send: (event) => actor.send(event),
    getView: read,
    subscribe(listener) {
      const sub = actor.subscribe(() => listener());
      return () => sub.unsubscribe();
    },
    stop: () => actor.stop(),
  };
}
