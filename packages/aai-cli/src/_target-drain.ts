// Copyright 2026 the AAI authors. MIT license.
/**
 * The one entry-source fragment the LONG-LIVED targets share.
 *
 * A leaf beside `_target-output.ts` (the directory the same two targets share)
 * and `_target-bundle.ts` (the bundle every target's entry goes through): each
 * is a thing more than one host needs and no host owns.
 */

/**
 * The signal drain both LONG-LIVED entries carry, interpolated into each.
 *
 * ## Why every long-lived host needs one
 *
 * A host that runs a process stops that process — on a scale-in, on a redeploy,
 * on an instance being moved — and for a voice agent that is a live call. Left
 * to the default disposition the process dies with its sockets open: the caller
 * hears nothing more, the STT and TTS connections are dropped rather than
 * closed, and nothing downstream is told the session ended. `server.close()`
 * shuts the runtime down with the process, so sessions END.
 *
 * The Deno entry did NOT have this and the Modal entry did, which was a gap
 * rather than a decision: Deno Deploy stops a deployment on exactly the same
 * events. Nitro has no such asymmetry — every one of its long-lived presets
 * (`node-server`, `deno-server`, `bun`) serves through srvx, which closes on
 * `SIGINT`/`SIGTERM`, and `setupCloseHooks` hangs the framework's own `close`
 * hooks off that one path. This is the same property with our own two hosts
 * spelled out, which is why it is ONE constant: the next long-lived target
 * must not get to rediscover it.
 *
 * ## Two things in the body that are not incidental
 *
 * The listeners are SYNCHRONOUS for the reason `executeStart` documents: an
 * `async` listener hands its promise to `process`, which discards it, so a
 * failed shutdown would surface as an unhandled rejection rather than a
 * non-zero exit.
 *
 * Registration is GUARDED, because signal support is a property of the host
 * rather than of the runtime. Deno delivers `process.on("SIGTERM")` through
 * `Deno.addSignalListener`, which THROWS where the platform has no signal to
 * deliver — an isolate-based Deploy, or a Windows `SIGTERM` — and a throw at
 * the top level of the entry is a deployment that does not boot at all. A host
 * that cannot signal us is a host we have nothing to drain on, so failing to
 * register is not a failure.
 */
export const TARGET_DRAIN_SOURCE = `// The host stops this process on every scale-in and every redeploy; closing the
// server ends live sessions instead of dropping their sockets.
for (const name of ["SIGINT", "SIGTERM"]) {
  try {
    process.once(name, () => {
      server.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  } catch {
    // No signal support on this host — nothing will ever arrive to drain on.
  }
}
`;
