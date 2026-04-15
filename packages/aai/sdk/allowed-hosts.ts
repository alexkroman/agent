// Copyright 2025 the AAI authors. MIT license.
/**
 * Allowlist matching for outbound host validation.
 *
 * Used at deploy time (manifest validation) and at runtime (SSRF enforcement)
 * to restrict which external hosts an agent is permitted to contact.
 *
 * Lives in sdk/ because it has zero Node.js dependencies and can run in any
 * environment (browser, Deno, Node.js sandboxes).
 */

/** Private/special-use TLDs that must never appear in allowedHosts patterns. */
const BLOCKED_TLDS = ["local", "internal", "localhost"];

/**
 * Regex that matches an IPv4 address (four decimal octets separated by dots).
 * Anchored so partial matches like "192.168.1.1.example.com" don't trigger it.
 */
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

type ValidationResult = { valid: true } | { valid: false; reason: string };

function fail(reason: string): { valid: false; reason: string } {
  return { valid: false, reason };
}

function checkStructural(pattern: string): ValidationResult | null {
  if (pattern === "") return fail("Pattern must not be empty.");
  if (pattern.includes("://"))
    return fail("Pattern must not include a protocol (e.g. remove 'https://').");
  if (pattern.includes("/")) return fail("Pattern must not include a path component (remove '/').");
  if (pattern.includes("?")) return fail("Pattern must not include a query string (remove '?').");
  if (pattern.startsWith("[") || pattern.includes("::"))
    return fail("IP address literals are not allowed in allowedHosts patterns.");
  if (pattern.includes(":"))
    return fail("Pattern must not include a port number (e.g. remove ':8080').");
  return null;
}

function checkWildcard(pattern: string): ValidationResult | null {
  if (!pattern.includes("*")) return null;
  if (pattern === "*" || pattern === "**")
    return fail("Bare wildcard '*' is not allowed. Use '*.example.com' to allow all subdomains.");
  const wildcardIndex = pattern.indexOf("*");
  if (wildcardIndex !== 0 || pattern[1] !== ".")
    return fail("Wildcard '*' may only appear as the leading segment (e.g. '*.example.com').");
  if (pattern.lastIndexOf("*") !== 0)
    return fail("Only a single leading wildcard segment is supported.");
  return null;
}

function checkHostPart(hostPart: string): ValidationResult | null {
  if (IPV4_RE.test(hostPart))
    return fail("IP address literals are not allowed in allowedHosts patterns.");
  const tld = hostPart.split(".").at(-1)?.toLowerCase() ?? "";
  if (BLOCKED_TLDS.includes(tld))
    return fail(`Patterns ending in '.${tld}' are not allowed (private/special-use TLD).`);
  return null;
}

/**
 * Validate a single `allowedHosts` pattern at deploy time.
 *
 * Returns `{ valid: true }` for acceptable patterns or
 * `{ valid: false; reason: string }` with a human-readable rejection reason.
 */
export function validateAllowedHostPattern(pattern: string): ValidationResult {
  const structural = checkStructural(pattern);
  if (structural !== null) return structural;

  const wildcard = checkWildcard(pattern);
  if (wildcard !== null) return wildcard;

  const hostPart = pattern.startsWith("*.") ? pattern.slice(2) : pattern;
  const hostCheck = checkHostPart(hostPart);
  if (hostCheck !== null) return hostCheck;

  return { valid: true };
}

/**
 * Test whether `hostname` matches any pattern in `patterns`.
 *
 * - Exact match is case-insensitive; trailing dots on the hostname are stripped.
 * - Wildcard pattern `*.example.com` matches any hostname ending with
 *   `.example.com` (one or more labels), but does NOT match `example.com` itself.
 * - A port suffix on `hostname` (e.g. `api.example.com:8080`) is stripped before
 *   matching.
 * - Returns `false` when `patterns` is empty.
 */
export function matchesAllowedHost(hostname: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;

  // Strip port — only when there are no brackets (IPv6 bracket notation).
  const portIndex = hostname.lastIndexOf(":");
  let host = portIndex !== -1 && !hostname.includes("[") ? hostname.slice(0, portIndex) : hostname;

  // Normalise: lowercase + strip trailing dot
  host = host.toLowerCase().replace(/\.$/, "");

  for (const pattern of patterns) {
    const p = pattern.toLowerCase();
    if (p.startsWith("*.")) {
      // Wildcard: hostname must end with the suffix (e.g. ".example.com")
      const suffix = p.slice(1); // ".example.com"
      if (host.endsWith(suffix) && host.length > suffix.length) return true;
    } else if (host === p) {
      return true;
    }
  }

  return false;
}
