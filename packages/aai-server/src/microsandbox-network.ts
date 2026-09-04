// Copyright 2026 the AAI authors. MIT license.
/**
 * Making a microVM guest able to reach the developer's own machine — and
 * nothing more of it than it needs.
 *
 * ## Loopback does not mean what it means everywhere else here
 *
 * Under the `subprocess` backend the guest shares the host's network stack, so
 * a `127.0.0.1:54322` in its env is the local Supabase stack and everything
 * works. In a microVM, `127.0.0.1` is the VM. Handing that env through
 * unchanged is not a degraded experience, it is a broken one: `ctx.db`, agent
 * storage, uploads and durable workflows all resolve to a port nothing is
 * listening on, inside the guest.
 *
 * microsandbox publishes a host alias in the guest's `/etc/hosts`
 * ({@link HOST_ALIAS}) which routes to the host side of the guest's `/30`. Use
 * the NAME and never the address it resolves to: measured, the alias connects
 * and the raw gateway IP times out.
 *
 * ## And reaching the host is default-DENY
 *
 * The runtime's default policy allows public egress and allows the `host`
 * destination group on port 53 ONLY — so DNS works, the internet works, and
 * every other host port is refused. Which is the right posture: a guest runs
 * tenant code, and "can reach anything on the developer's laptop" is not a
 * thing to grant wholesale.
 *
 * So the two halves belong to one function. {@link rewriteLoopbackForGuest}
 * rewrites the env AND reports the ports it rewrote, and those ports — exactly
 * those — are what {@link applyGuestNetworkPolicy} opens. Deriving the
 * allow-list from the rewrite is what keeps it least-privilege without anybody
 * maintaining a list: a new loopback service in the guest's env is reachable
 * because it was rewritten, and nothing else becomes reachable at all.
 *
 * ## A custom policy REPLACES the defaults
 *
 * `policyFromBuilder` does not merge. Setting a policy that only adds a host
 * rule silently drops the built-in DNS rule, and the symptom is every hostname
 * failing to resolve inside the guest (`ENOTFOUND`) — measured, not guessed. So
 * the composition here re-declares all of it: DNS, public egress, then the
 * derived host ports.
 */

/**
 * The host, as seen from inside the guest. microsandbox writes this into the
 * guest's `/etc/hosts`; it is also the DNS server and the default gateway.
 */
export const HOST_ALIAS = "host.microsandbox.internal";

/**
 * Loopback spellings that mean "this machine" in a dev environment.
 *
 * The lookbehind rather than a `\b`: a word boundary cannot exist before the
 * `[` of `[::1]`, so an anchored form never matched that spelling at all. It
 * also stops `mylocalhost` counting as loopback, which `\b` would allow.
 */
const LOOPBACK = /(?<![\w.-])(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?/g;

/** Default ports for the schemes a loopback URL can omit a port on. */
const SCHEME_PORTS: Record<string, number> = { "http:": 80, "https:": 443 };

export type LoopbackRewrite = {
  /** The env to hand the guest, with every loopback host swapped for the alias. */
  env: Record<string, string>;
  /** The host ports the rewrite created a need for. Sorted, deduped. */
  hostPorts: number[];
};

/**
 * Rewrite every loopback host in an env to {@link HOST_ALIAS}, and report the
 * ports that now have to be reachable.
 *
 * A value with no explicit port contributes its SCHEME's default (a bare
 * `http://localhost/x` is port 80), because the guest will still open a
 * connection to it and a policy that omitted the port would refuse it.
 * A loopback mention with neither a port nor a recognizable scheme is rewritten
 * but contributes nothing: there is no port to open, and guessing one would
 * widen the policy on the strength of a guess.
 */
export function rewriteLoopbackForGuest(env: Record<string, string>): LoopbackRewrite {
  const ports = new Set<number>();
  const rewritten: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    rewritten[key] = value.replace(LOOPBACK, (_match, port: string | undefined, offset: number) => {
      // The replace callback's OFFSET, not `indexOf(match)`: a value with two
      // loopback mentions would resolve the second one's scheme from the first.
      const scheme = /(\w+:)\/\/[^/]*$/.exec(value.slice(0, offset))?.[1];
      const resolved = port ? Number(port) : scheme && SCHEME_PORTS[scheme];
      if (typeof resolved === "number") ports.add(resolved);
      return port ? `${HOST_ALIAS}:${port}` : HOST_ALIAS;
    });
  }
  return { env: rewritten, hostPorts: [...ports].sort((a, b) => a - b) };
}

/**
 * Make one URL reachable from a guest, when the CALLER is a guest in a microVM.
 *
 * The env rewrite above covers every URL the platform hands a guest at SPAWN. This
 * covers the ones it mints at RUNTIME, and there is exactly one class of those:
 * `GET /:slug/uploads/:id/:offset` answers a **302 to a Supabase signed URL**, and
 * the guest follows it. Locally that URL is on `SUPABASE_URL`, i.e.
 * `http://127.0.0.1:54321` — the VM itself — so `stepReadUpload` inside a step failed
 * as a bare `TypeError: fetch failed`, retried four times, and killed the run:
 *
 *     [Workflow] Max retries reached, bubbling error to parent workflow
 *       stepName: 'step//./workflows/stream//planStreamed'
 *       errorStack: 'TypeError: fetch failed'
 *
 * **Decided by the request, not by the backend.** `guestReachableUrl` keys off
 * `SANDBOX_BACKEND`, which is right where the platform is choosing what to bake
 * into a guest it is spawning — and wrong here, because these routes serve
 * BROWSERS too (they are unauthenticated by design; a browser uploads through
 * them). {@link HOST_ALIAS} resolves nowhere outside a microVM, so rewriting for
 * a browser would break exactly the caller the plain URL is correct for.
 *
 * A `Host` of the alias is the one thing that identifies the caller as being
 * inside a microVM, and it is not a guess a caller could profit from forging: the
 * only effect is which host IT is told to dial for bytes it already holds an
 * unguessable id for.
 */
export function callerReachableUrl(url: string, hostHeader: string | undefined): string {
  if (hostHeader?.split(":")[0]?.toLowerCase() !== HOST_ALIAS) return url;
  return rewriteLoopbackForGuest({ url }).env.url ?? url;
}

/**
 * Guest env keys whose value is NOT dialled by the guest, and so may keep a
 * loopback host — with the reason, because that is the whole point of the list.
 *
 * {@link assertGuestCanReachItsEnv} refuses a loopback anywhere else, so a new
 * URL-valued boot key DEFAULTS INTO being checked and exempting one costs a line
 * here. That polarity is the mechanism: the failures this guards are silent, and
 * every one of them arrived as a key somebody added without asking which side of
 * the boundary its value points at.
 */
const NOT_DIALLED_BY_THE_GUEST: Record<string, string> = {
  // What a THIRD PARTY is handed by `ctx.workflows.publicWebhookUrl`. The alias
  // resolves nowhere outside a microVM, so rewriting this one would break exactly
  // the caller it exists for — `agentPlatformBaseUrl` in public-origin.ts is the
  // dial-side twin that carries the argument, and the reason there are two keys.
  AAI_PUBLIC_BASE_URL: "handed to third parties; must resolve from the internet",
};

/** Any loopback host still named in a value, with the port when it carries one. */
function loopbackMentions(value: string): string[] {
  return [...value.matchAll(LOOPBACK)].map((m) => m[0]);
}

/**
 * Refuse to spawn a guest that was handed a URL it cannot reach.
 *
 * **The exhaustive half of a rule that has only ever been a convention.**
 * `guestReachableUrl`'s doc asks that "anything that hands a URL across this
 * boundary" go through it; that is a per-call-site habit, and it was forgotten
 * five times — the agent env's DSNs, the worker bundle URL, the in-guest `aai
 * deploy` origin, the platform dial base, and a signed upload read. Every one of
 * them failed SILENTLY and identically from the outside: a connection to a port
 * nothing is listening on, inside the VM.
 *
 * This asserts the property instead of the habit, over the whole environment
 * rather than a list of keys, so a key added tomorrow is covered by construction.
 * It also asserts the SECOND half, which is not optional and not obvious: a URL
 * correctly rewritten to {@link HOST_ALIAS} on a port the egress policy never
 * opened fails in precisely the same way as one left on loopback. Both halves or
 * neither.
 *
 * A THROW rather than a warning, and before the sandbox exists: the alternative is
 * the state this whole family of bugs lives in — a guest that boots, looks
 * healthy, and fails at the first step that touches the unreachable thing, with
 * the error naming a fetch and nothing naming the key.
 *
 * Checkable with no VM, which is the reason it is a function and not a scenario
 * test: the microsandbox tier skips wherever nested virtualization is absent —
 * every GitHub runner included — so a property that needs a real microVM to
 * observe is a property CI never evaluates.
 */
export function assertGuestCanReachItsEnv(
  env: Record<string, string>,
  hostPorts: readonly number[],
): void {
  const open = new Set(hostPorts);
  const problems: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (key in NOT_DIALLED_BY_THE_GUEST) continue;
    for (const mention of loopbackMentions(value)) {
      problems.push(
        `${key} still names ${mention}, which inside a microVM is the GUEST — ` +
          "rewrite it through rewriteLoopbackForGuest, or declare it in " +
          "NOT_DIALLED_BY_THE_GUEST with the reason it is not dialled",
      );
    }
    // The alias with a port the policy did not open. Same failure as the above,
    // and the one a reviewer looking only at the URL cannot see.
    for (const [, port] of value.matchAll(ALIAS_PORT)) {
      if (port !== undefined && !open.has(Number(port))) {
        problems.push(
          `${key} dials ${HOST_ALIAS}:${port}, which the egress policy does not ` +
            `open (open: ${[...open].sort((a, b) => a - b).join(", ") || "none"})`,
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `this guest was handed ${problems.length} unreachable value(s):\n  - ${problems.join("\n  - ")}`,
    );
  }
}

/** `host.microsandbox.internal:<port>` in a value, capturing the port. */
const ALIAS_PORT = new RegExp(`${HOST_ALIAS.replace(/\./g, "\\.")}:(\\d+)`, "g");

/** DNS, which the guest reaches on the host and which a custom policy must re-declare. */
const DNS_PORT = 53;

/** Egress defaults: an unlisted destination is REFUSED rather than reached. */
export const GUEST_EGRESS_DEFAULT = "deny";

/**
 * Ingress default. The only thing that reaches a guest is the published port
 * the host itself forwards, so there is nothing here to deny.
 */
export const GUEST_INGRESS_DEFAULT = "allow";

/**
 * One egress rule. An empty `ports` means every port on that destination —
 * which is why the host rules always carry ports and the public one does not.
 */
export type GuestEgressRule = {
  protocols: readonly ("tcp" | "udp")[];
  ports: readonly number[];
  group: "host" | "public";
};

/**
 * The guest's whole egress policy, as DATA.
 *
 * Data rather than calls onto the SDK's builder for two reasons: the rules are
 * then asserted directly instead of through a recording fake, and the SDK stays
 * a dev-only dynamic import that this module never has to type. The one caller
 * that owns the builder maps these onto it (`microsandbox-sandbox.ts`).
 *
 * All three parts are re-declared every time because `policyFromBuilder` does
 * not MERGE — see the module doc. Dropping the DNS rule is the interesting
 * failure: everything still builds and every hostname in the guest fails to
 * resolve.
 */
export function guestEgressRules(hostPorts: readonly number[]): GuestEgressRule[] {
  const rules: GuestEgressRule[] = [
    // DNS: the resolver is the host, and UDP is what it tries first.
    { protocols: ["tcp", "udp"], ports: [DNS_PORT], group: "host" },
    // The internet — provider APIs, the npm registry a workspace build needs.
    { protocols: ["tcp"], ports: [], group: "public" },
  ];
  if (hostPorts.length > 0) {
    rules.push({ protocols: ["tcp"], ports: [...hostPorts], group: "host" });
  }
  return rules;
}

/**
 * Host ports a guest needs open for URLs the platform mints at RUNTIME.
 *
 * The derived allow-list above covers every port named in an env value the guest
 * was handed. A signed upload URL is not one of those — it is minted per read, on
 * the platform's Supabase origin — so following the 302 hits a port the policy
 * never opened, and the symptom is identical to the URL being wrong (a bare
 * `fetch failed`). Both halves are needed; fixing either alone leaves the run
 * dead.
 *
 * Derived from `SUPABASE_URL` rather than declared, for the reason the rewrite
 * derives its own list: a port nobody maintains cannot go stale. Empty when the
 * origin is not loopback (a real Supabase project needs no host rule) or
 * unparseable.
 */
export function runtimeMintedHostPorts(env: NodeJS.ProcessEnv = process.env): number[] {
  const raw = env.SUPABASE_URL?.trim();
  if (!raw) return [];
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (!(host === "localhost" || host === "[::1]" || host.startsWith("127."))) return [];
    const port = url.port ? Number(url.port) : SCHEME_PORTS[url.protocol];
    return typeof port === "number" && Number.isInteger(port) ? [port] : [];
  } catch {
    return [];
  }
}
