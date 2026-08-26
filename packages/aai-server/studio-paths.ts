// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio surface, as one predicate.
 *
 * This is the boundary the combined entry dispatches on
 * (aai-studio-server/index.ts): these paths go to the studio app, everything
 * else — including `/health` and the WebSocket upgrades — to the agent
 * orchestrator. Adding a studio path means editing this and the studio app's
 * routes; nothing else reads the list.
 *
 * It lives in this package (the shared platform core) rather than beside its
 * only caller because it has to agree with RESERVED_SLUGS, which is here:
 * `studio` and `studio-assets` are reserved precisely so no agent route can
 * shadow the namespace. studio-paths.test.ts asserts the two agree.
 *
 * This module used to also hold the split deployment's reverse proxy
 * (`createStudioProxy` — agent service forwarding the studio surface to a
 * standalone studio service, plus `gracefulEventStream` to keep proxied SSE
 * endable at shutdown). The split is gone; see the "One app, both surfaces"
 * note in modal_deploy.py for why, and git history for the proxy itself.
 */

export function isStudioPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/favicon.ico" ||
    // `/robots.txt` belongs here for the reason `/favicon.ico` does — a crawler
    // asks the ROOT for it, and this host's root is the studio. Absent, it fell
    // through to the agent orchestrator, matched `/:slug`, and `validateSlug`
    // answered `400 Bad Request`: production really served that to a crawler.
    // A well-formed request for a standard file is not a bad request, and the
    // status is the one thing a crawler acts on.
    pathname === "/robots.txt" ||
    pathname === "/studio" ||
    pathname.startsWith("/studio/") ||
    pathname.startsWith("/studio-assets/")
  );
}
