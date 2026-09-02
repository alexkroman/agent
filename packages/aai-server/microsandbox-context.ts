// Copyright 2026 the AAI authors. MIT license.
/**
 * The one place that touches the `microsandbox` SDK.
 *
 * Split from `microsandbox-sandbox.ts` when that file hit the 500-line cap, and
 * the seam is the one its own section heading already drew: everything here is
 * the ADAPTER — the SDK's builder, its `Sandbox` statics, its network-policy
 * builder, and its exec stream reduced to the `MicrosandboxHandle` both spawners
 * consume. That module keeps the parts a unit test can reach without booting a
 * VM: the constants, the injectable types, the image reference, and the warm
 * spawner.
 *
 * Which makes the boundary useful rather than incidental — the SDK is a DYNAMIC
 * import (see {@link defaultMicrosandboxContext}), so this is also the only file
 * whose specifier must never be evaluated in production, and having it alone in
 * a module makes that checkable by reading one import list.
 */

import { errorMessage } from "@alexkroman1/aai";
import { invariant } from "@alexkroman1/aai/internal";
import type { NetworkPolicyBuilder } from "microsandbox";
import { createLogger } from "./logger.ts";
import {
  GUEST_EGRESS_DEFAULT,
  GUEST_INGRESS_DEFAULT,
  guestEgressRules,
} from "./microsandbox-network.ts";
import type { MicrosandboxProcLike, MicrosandboxSpawnContext } from "./microsandbox-sandbox.ts";
import { GUEST_PORT } from "./modal-context.ts";
import { SandboxNameTakenError } from "./sandbox-directory.ts";

const log = createLogger("sandbox.microsandbox");

// ── The real context ─────────────────────────────────────────────────────────

/**
 * Adapt one `ExecHandle` to the `GuestProcLike` both spawners consume.
 *
 * The handle is a single async iterable of `{kind}`-tagged events; the host side
 * wants two byte streams plus an exit. The pump NEVER stops early — a guest
 * blocked on a full pipe wedges on its next write, which is the invariant
 * `warm-harness.ts` states for every backend.
 */
function procFromExec(handle: {
  [Symbol.asyncIterator](): AsyncIterator<
    | { kind: "stdout" | "stderr"; data: Uint8Array }
    | { kind: "exited"; code: number }
    | { kind: "started"; pid: number }
  >;
  kill(): Promise<void>;
}): MicrosandboxProcLike {
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let err!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start: (controller) => {
      out = controller;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start: (controller) => {
      err = controller;
    },
  });

  const exit = (async (): Promise<number> => {
    let code = -1;
    try {
      for await (const event of handle) {
        if (event.kind === "stdout") out.enqueue(event.data);
        else if (event.kind === "stderr") err.enqueue(event.data);
        else if (event.kind === "exited") code = event.code;
      }
    } catch {
      // Peer death mid-stream is the exit paths' business, not this pump's.
    }
    out.close();
    err.close();
    return code;
  })();

  return {
    stdout,
    stderr,
    wait: () => exit,
    kill: () => {
      void handle.kill().catch(() => undefined);
    },
  };
}

/**
 * Map {@link guestEgressRules} onto the SDK's policy builder.
 *
 * Typed against the real `NetworkPolicyBuilder` — the rules being plain data is
 * what lets this be the only place that touches the SDK's shape, with no
 * structural stand-in to bridge and therefore no cast.
 */
function applyPolicy(
  builder: NetworkPolicyBuilder,
  hostPorts: readonly number[],
): NetworkPolicyBuilder {
  builder.defaultEgress(GUEST_EGRESS_DEFAULT).defaultIngress(GUEST_INGRESS_DEFAULT);
  for (const rule of guestEgressRules(hostPorts)) {
    builder.egress((r) => {
      for (const protocol of rule.protocols) {
        if (protocol === "tcp") r.tcp();
        else r.udp();
      }
      if (rule.ports.length > 0) r.ports([...rule.ports]);
      return r.allow((destination) => destination.group(rule.group));
    });
  }
  return builder;
}

/**
 * The real microVM context.
 *
 * The SDK is a DYNAMIC import: `aai-server` is compiled into the studio entry
 * every deployment runs, and a static import of a native addon would put a
 * top-level require of it in that bundle. Backend selection cannot reach this
 * backend in production, so the specifier is never evaluated there — while
 * `import type` keeps the shapes above fully checked.
 */
/**
 * Statuses in which a name's holder is a LIVE sandbox, so the name is genuinely
 * taken. The other two — `stopped` and `crashed` — are orphans.
 */
const LIVE_STATUSES: ReadonlySet<string> = new Set(["running", "draining"]);

/** microsandbox's duplicate-name refusal. Matched on the message; see below. */
function isNameTaken(err: unknown): boolean {
  return /already exists/i.test(errorMessage(err));
}

/**
 * Create the sandbox, reclaiming the name from a DEAD holder.
 *
 * **`sandbox-directory.ts` rests on "a name is released when the sandbox
 * stops", and that is a property of MODAL, not of naming.** microsandbox keeps
 * its own store (`~/.microsandbox/db/msb.db`), and a row survives an ungraceful
 * death — `.ephemeral(true)` cleans up on a graceful stop and cannot run at all
 * when the VM is SIGKILLed. So a hard-killed guest left its name claimed
 * forever, and since the name carries the deploy version
 * (`agent-<hash(slug)>-v<version>`) it is the SAME name every later spawn asks
 * for. Measured: kill the `msb sandbox` process of a running agent and every
 * subsequent spawn fails with `sandbox '…' already exists`, so the slug is
 * permanently unreachable — `/client-config`, `/workflows`, a durable-run wake,
 * all of them answering `agent unavailable, retry shortly`, a 503 that reads as
 * transient and can never succeed. A redeploy (new version, new name) was the
 * only exit.
 *
 * The reclaim reproduces Modal's semantics rather than papering over them:
 *
 * - Holder is `running` or `draining` → a real peer owns this deploy. Throw
 *   {@link SandboxNameTakenError}, exactly as `translateCreateError` does for
 *   Modal, so the broker routes to that peer instead of retrying a create that
 *   can only lose again. Blue-green handover depends on this: a slug
 *   legitimately has two live sandboxes for minutes.
 * - Holder is `stopped` or `crashed` → an orphan. Remove it and retry ONCE.
 * - The holder is gone between the failure and the read → retry once too; the
 *   name is evidently free now.
 *
 * The retry is single: a second collision means a live racer took the name in
 * between, which is the `SandboxNameTakenError` case and the broker's to
 * resolve.
 *
 * The refusal is matched on the MESSAGE because the SDK exports no error class
 * for it — the same `instanceof` that `translateCreateError` warns is
 * load-bearing, minus the type. A widened match is the safe direction here: a
 * false positive costs one status read that finds nothing to reclaim.
 *
 * Takes a FACTORY rather than a builder, because a `SandboxBuilder` is
 * single-use: reusing one for the retry fails with `SandboxBuilder already
 * consumed`, which is a second permanent failure wearing a different message —
 * measured against the real SDK on the very agent this reclaim was written to
 * rescue.
 */
async function createReclaimingName<T>(
  build: () => { create(): Promise<T> },
  name: string,
  sdk: {
    get(name: string): Promise<{ status: string }>;
    remove(name: string): Promise<void>;
  },
): Promise<T> {
  try {
    return await build().create();
  } catch (err) {
    if (!isNameTaken(err)) throw err;
    const status = await sdk
      .get(name)
      .then((handle) => handle.status)
      .catch(() => undefined);
    if (status !== undefined && LIVE_STATUSES.has(status)) {
      throw new SandboxNameTakenError(name, { cause: err });
    }
    log.warn("Reclaiming a microVM name from a dead holder", { name, status: status ?? "gone" });
    if (status !== undefined) await sdk.remove(name);
    return build().create();
  }
}

/**
 * The real microVM context — the default for both spawners.
 *
 * Exported rather than `_internals`-only because the agent spawner lives in its
 * own module now and must default to the SAME context; a second construction
 * there is how the two paths would drift on how a guest is built.
 */
export function defaultMicrosandboxContext(): MicrosandboxSpawnContext {
  return {
    async createSandbox(params) {
      const { Sandbox, NetworkPolicyBuilder } = await import("microsandbox");
      // A FACTORY, because a `SandboxBuilder` is single-use and the name reclaim
      // below has to be able to create twice — see `createReclaimingName`.
      const build = () => {
        let builder = Sandbox.builder(params.name)
          .image(params.imageRef)
          // The image is built locally or pulled once; never re-fetched per spawn.
          .pullPolicy("if-missing")
          .ephemeral(true)
          .quietLogs()
          .envs(params.env)
          .labels(params.labels)
          // The published port goes INSIDE `.network()`, and that is not a style
          // choice: `.network()` replaces the accumulated network config, so a
          // `.port()` called before it is DISCARDED. The failure is a silent
          // no-forward — the harness logs `listening on 0.0.0.0:8080` inside the
          // guest while every host dial gets ECONNREFUSED for the full 30s dial
          // budget, which reads as a guest that failed to boot.
          //
          // Publishes on 127.0.0.1 by default, which is the loopback posture
          // `subprocess` has to set by hand.
          .network((network) =>
            network
              .port(params.hostPort, GUEST_PORT)
              .policyFromBuilder(applyPolicy(new NetworkPolicyBuilder(), params.hostPorts)),
          );
        if (params.memoryLimitMiB !== undefined) builder = builder.memory(params.memoryLimitMiB);
        if (params.cpus !== undefined) builder = builder.cpus(params.cpus);
        return builder;
      };
      const sandbox = await createReclaimingName(build, params.name, Sandbox);

      return {
        exec: async (command) => {
          const [cmd, ...args] = command;
          // Every `exec` in this package passes a literal argv this repo wrote;
          // an empty one is a mis-assembly here, not a caller's bad input.
          invariant(cmd !== undefined, "guest.exec.argv", () => ({ command }));
          return procFromExec(await sandbox.execStream(cmd, args));
        },
        writeFile: (path, data) => sandbox.fs().write(path, data),
        stop: () => sandbox.stop(),
      };
    },
  };
}

export const _contextInternals = { createReclaimingName, procFromExec };
