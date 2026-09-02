// Copyright 2026 the AAI authors. MIT license.
/**
 * `assertGuestBearer` — the gate every GUEST-CALLED route on `/:slug` shares,
 * and which had no spec of its own.
 *
 * It is written as a real Hono app rather than a hand-built `AppContext`
 * because that type is a `Context<HonoEnv>` with ~40 members: a double would
 * have to be cast, and a cast stops reporting the moment the shape changes,
 * which is the opposite of what a spec on an AUTH gate is for. `app.fetch(req,
 * env)` supplies the bindings honestly, and the four the gate never touches are
 * inert memory implementations.
 *
 * The cases are the ones the empty-secret audit asked of every constant-time
 * comparison on the platform: what happens when the expected value could be
 * blank, and what happens when the presented one is.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, test } from "vitest";
import type { HonoEnv } from "./context.ts";
import { assertGuestBearer } from "./guest-bearer.ts";
import { guestTokenFor, resetGuestTokenKey } from "./guest-token.ts";
import { localSlugLock } from "./platform-lock.ts";
import { agentSandboxName } from "./sandbox-directory.ts";
import { createMemorySecretStore } from "./secret-store.ts";
import { createTestStore } from "./test-utils.ts";

const SLUG = "demo";
const VERSION = 3;

/**
 * A store answering one agent version and nothing else.
 *
 * The gate reads exactly one method, and the version is what MINTS the expected
 * token — so a store double here is a statement about the agent existing, not a
 * stand-in for persistence.
 */
function bindings(version: number | null): HonoEnv["Bindings"] {
  const store = createTestStore();
  return {
    store: { ...store, getAgentVersion: async () => version },
    secrets: createMemorySecretStore(),
    slugLock: localSlugLock,
  };
}

/**
 * Drive the gate once. Answers the status it produced.
 *
 * `version` is read with `in` rather than `??`: `null` is a MEANINGFUL value
 * here ("no such agent") and `opts.version ?? VERSION` would collapse it into
 * the present case, quietly turning the two 503 cases into 401 and 200.
 */
async function call(opts: { header?: string; version?: number | null }): Promise<number> {
  const app = new Hono<HonoEnv>();
  app.get("/", async (c) => {
    await assertGuestBearer(c, SLUG);
    return c.text("ok");
  });
  const headers = "header" in opts ? { authorization: String(opts.header) } : {};
  const res = await app.fetch(
    new Request("http://platform.test/", { headers }),
    bindings("version" in opts ? (opts.version ?? null) : VERSION),
  );
  return res.status;
}

describe("assertGuestBearer", () => {
  beforeEach(() => {
    // The HMAC key is a lazily-drawn process fallback when
    // `AAI_GUEST_TOKEN_SECRET` is unset, so a token minted in one test must not
    // silently depend on one drawn in another.
    resetGuestTokenKey();
  });

  test("admits the bearer the running guest would hold", async () => {
    const token = guestTokenFor(agentSandboxName(SLUG, VERSION));
    await expect(call({ header: `Bearer ${token}` })).resolves.toBe(200);
  });

  test("admits it under a lower-cased scheme, per RFC 7235 §2.1", async () => {
    // This gate takes the SHARED `parseBearer` now
    // (`@alexkroman1/aai-runtime/internal`) rather than a fourth copy of the
    // scheme match. Asserted here and not only in that module's spec, because
    // the delegation is what could be undone.
    const token = guestTokenFor(agentSandboxName(SLUG, VERSION));
    await expect(call({ header: `bearer ${token}` })).resolves.toBe(200);
  });

  test("refuses a wrong bearer with 401", async () => {
    await expect(call({ header: "Bearer nope" })).resolves.toBe(401);
  });

  test("refuses a missing bearer with 401, not 400", async () => {
    // No credential supplied is the ordinary unauthenticated case.
    await expect(call({})).resolves.toBe(401);
  });

  /**
   * The empty-comparison family, asked of this gate.
   *
   * `constantTimeEquals("", "")` is TRUE — `timingSafeEqual` matches two empty
   * buffers — which is what turned `AAI_SESSION_EVENTS_TOKEN=` into an open
   * gate in the runtime. This gate never reaches that state, by two independent
   * facts, and both are asserted rather than argued: the `supplied === ""`
   * refusal runs BEFORE the version read, and `guestTokenFor` answers a 64-hex
   * digest that is never empty. Reordering the first below the version read
   * would reintroduce the class, which is what these cases would catch.
   */
  test.each(["Bearer", "Bearer ", "Bearer    ", "bearer\t", "Basic ", "", "   "])(
    "a header that resolves to NO token (%j) is 401, never a match",
    async (header) => {
      await expect(call({ header })).resolves.toBe(401);
    },
  );

  test("the expected token is never blank, whatever the version", async () => {
    // The second fact, stated where a change to the derivation would break it.
    for (const version of [0, 1, VERSION, 999]) {
      expect(guestTokenFor(agentSandboxName(SLUG, version))).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("the 401 wins over the not-found answer when BOTH would fire", async () => {
    // The ordering, pinned by the one case where it is observable: no credential
    // and no such agent. Swapping the two refusals tells a caller who supplied
    // NOTHING that this slug is unknown, which is the narrow line this gate does
    // hold. A/B'd: this is the only case in the file that reddens against the
    // swapped order, and it is unaffected by what the loser's status is.
    await expect(call({ version: null })).resolves.toBe(401);
  });

  test("a well-formed bearer for an unknown agent is 404, not 503", async () => {
    // The bug, and the reason its predecessor's justification did not hold.
    //
    // A delete leaves no tombstone — the agents row is gone and all ten tenant
    // tables cascade off it — so there is no later, and a 503 asks a guest to
    // come back to a row that will never return while booking the absence as a
    // PLATFORM fault (a warn line per request, out of `error-handler.ts`). It
    // cannot be a deploy window either: agent rows are written `on conflict
    // (slug) do update set`, so `null` only ever means gone.
    //
    // The 503 was defended as refusing an existence oracle. The case below shows
    // the oracle was open the whole time, one status over.
    const token = guestTokenFor(agentSandboxName(SLUG, VERSION));
    await expect(call({ header: `Bearer ${token}`, version: null })).resolves.toBe(404);
  });

  test("the existence oracle the 503 claimed to close was open beside it", async () => {
    // The failing-first observation for the case above, stated as the pair that
    // makes it: ONE junk bearer, two slugs, two different statuses. Under the old
    // code these were 401 and 503; they are 401 and 404 now. Either way a caller
    // learns which slugs exist — so hiding it was never what the 503 bought, and
    // this asserts the pair still DIFFERS rather than asserting it does not, so
    // nobody reads the fix as having opened something.
    //
    // What actually keeps this in line with the rest of the surface is that
    // `brokerSessionUrlOrThrow` and `upload-handler.ts`'s `assertAgentExists`
    // already answer 404 for an unknown slug to a caller with no credential at
    // all. Existence is public here by design; only this gate was coy about it.
    await expect(call({ header: "Bearer junk" })).resolves.toBe(401);
    await expect(call({ header: "Bearer junk", version: null })).resolves.toBe(404);
  });

  test("throws an HTTPException rather than answering itself", async () => {
    // The gate is `assert`-shaped: callers mount it ahead of a handler and rely
    // on hono's exception handling for the reply, so a version that returned a
    // boolean would leave every route to remember the refusal.
    const app = new Hono<HonoEnv>();
    let caught: unknown;
    app.get("/", async (c) => {
      try {
        await assertGuestBearer(c, SLUG);
      } catch (err) {
        caught = err;
      }
      return c.text("done");
    });
    await app.fetch(new Request("http://platform.test/"), bindings(VERSION));
    expect(caught).toBeInstanceOf(HTTPException);
    expect((caught as HTTPException).status).toBe(401);
  });
});
