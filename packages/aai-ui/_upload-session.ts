// Copyright 2026 the AAI authors. MIT license.
/**
 * Driving ONE resumable upload from a page: its id, and the gate a person can
 * close.
 *
 * The SDK already survives the server going away — a round that fails for a
 * reason that looks like an outage re-enters itself with `resume: true` and sends
 * only the windows that are missing (`aai/sdk/_upload-resume.ts`). This is the
 * same mechanism turned around and handed to the PERSON: pausing is an outage
 * they caused, resuming is the round after it, and the store cannot tell the two
 * apart because there is nothing to tell apart.
 *
 * ## Why a gate rather than a boolean
 *
 * Pausing has to do two things that a `paused` flag cannot: stop the bytes that
 * are already on the wire, and hold the loop that would send the next ones. So it
 * is an `AbortController` and a promise — abort what is in flight, and park the
 * uploader on `settle()` until somebody opens the gate again.
 *
 * The controller is REPLACED on resume rather than reused, because an aborted
 * signal stays aborted; a caller therefore has to read {@link UploadGate.signal}
 * fresh for each attempt rather than capturing it once.
 *
 * ## The loop this is built for
 *
 * ```ts no-check
 * while (!gate.cancelled) {
 *   await gate.settle();
 *   if (gate.cancelled) break;
 *   try {
 *     await api.uploadStream(id, file, { signal: gate.signal, resume: tried });
 *     break;
 *   } catch (err) {
 *     // An abort that is not a cancel is a PAUSE: go back and wait.
 *     if (!isAbort(err) || gate.cancelled) throw err;
 *   }
 * }
 * ```
 *
 * **The catch keys off the abort, not off `gate.paused`,** and that is the one
 * subtle part. Pausing and immediately resuming — a double-click, or a person
 * changing their mind inside the round trip — resolves the gate before the
 * rejection this abort caused has even landed, so a `paused` check would read
 * `false` and rethrow an `AbortError` as though the upload had failed. Every
 * abort reaching that catch was caused by this gate, so every one of them is a
 * pause unless the gate was cancelled outright.
 */

/** A person's pause, as the uploader sees it. */
export type UploadGate = {
  /** Whether the gate is currently closed. For rendering, not for control flow. */
  readonly paused: boolean;
  /** Whether the upload was abandoned. A cancelled gate never opens again. */
  readonly cancelled: boolean;
  /**
   * The signal for the NEXT attempt. Re-read it per attempt: resuming installs a
   * fresh controller, and the previous one stays aborted forever.
   */
  readonly signal: AbortSignal;
  /** Stop the bytes in flight and hold the uploader. A no-op when already closed. */
  pause: () => void;
  /** Open the gate and install a fresh signal. A no-op when not paused. */
  resume: () => void;
  /**
   * Abandon the upload for good.
   *
   * Distinct from a pause in exactly one way that matters to the loop above: it
   * releases the gate rather than holding it, so an uploader parked on `settle()`
   * wakes up and leaves instead of waiting for a resume that is not coming. What
   * a caller does with a cancelled upload's stored windows is its own business —
   * they stay in the store, addressable by an id only the caller has.
   */
  cancel: () => void;
  /** Resolves as soon as the gate is open — immediately, when it already is. */
  settle: () => Promise<void>;
};

/** Whether this rejection is an abort, in either of the two shapes runtimes throw. */
export function isAbortError(err: unknown): boolean {
  // `DOMException` in a browser and an `Error` subclass under Node's fetch, so the
  // NAME is the only thing both agree on — and it is what the spec pins.
  return err instanceof Error && err.name === "AbortError";
}

/** A fresh upload id: a capability, so it is random rather than derived. */
export function randomUploadId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/**
 * Send one file, waiting out however many pauses the person takes.
 *
 * The loop from the module doc, written once: both hooks need exactly this and a
 * second copy of it is a second place for the abort/pause distinction to be got
 * wrong. `send` is handed whether this attempt must CLAIM the id as its own —
 * false the first time, since a fresh id has nothing to resume and saying
 * otherwise waives the refusal that makes a caller-chosen id safe.
 *
 * Throws whatever `send` threw, except an abort the gate caused. A cancelled gate
 * throws too: the caller distinguishes it by reading `gate.cancelled`, which is
 * how an abandoned submission unwinds without being reported as a failure.
 */
export async function sendThroughGate(
  gate: UploadGate,
  send: (resume: boolean) => Promise<void>,
): Promise<void> {
  let tried = false;
  for (;;) {
    await gate.settle();
    if (gate.cancelled) throw new Error("Upload cancelled.");
    const resume = tried;
    tried = true;
    try {
      await send(resume);
      return;
    } catch (err: unknown) {
      if (gate.cancelled || !isAbortError(err)) throw err;
    }
  }
}

/**
 * A gate, open.
 *
 * One per upload rather than one per hook: the id and the windows already stored
 * belong to a file, so a gate that outlived its file would resume something else.
 */
export function createUploadGate(): UploadGate {
  let controller = new AbortController();
  let paused = false;
  let cancelled = false;
  let open: (() => void) | undefined;
  let closed: Promise<void> | undefined;

  return {
    get paused() {
      return paused;
    },
    get cancelled() {
      return cancelled;
    },
    get signal() {
      return controller.signal;
    },
    pause() {
      if (paused || cancelled) return;
      paused = true;
      // `Promise.withResolvers` rather than a captured `resolve` out of a `new
      // Promise` — the repo's rule, and here it is also the whole of the state.
      const gate = Promise.withResolvers<void>();
      closed = gate.promise;
      open = gate.resolve;
      controller.abort();
    },
    resume() {
      if (!paused || cancelled) return;
      paused = false;
      // A fresh controller, because the old one is aborted for good.
      controller = new AbortController();
      open?.();
      open = undefined;
      closed = undefined;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      paused = false;
      controller.abort();
      // Released rather than held — see the doc on `cancel` above.
      open?.();
      open = undefined;
      closed = undefined;
    },
    async settle() {
      if (closed) await closed;
    },
  };
}
