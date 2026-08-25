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
