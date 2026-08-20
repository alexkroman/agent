// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import {
  createSupabaseManagementApi,
  isProjectRef,
  projectRefFromDbUrl,
} from "./supabase-management.ts";

const REF = "testreftestreftestre";

/**
 * The SDK calls the runtime's own `fetch`, with no injection point — so the seam
 * for these specs is the global. `restoreMocks` in the vitest config puts it back
 * before the next test.
 */
function stubFetch(body: string, status = 200, contentType = "application/json") {
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(body, { status, headers: { "content-type": contentType } }));
  return spy;
}

function requestOf(spy: ReturnType<typeof stubFetch>) {
  const call = spy.mock.calls[0];
  const init = call?.[1];
  return {
    url: String(call?.[0] ?? ""),
    method: init?.method,
    headers: new Headers(init?.headers),
    body: String(init?.body ?? ""),
    hasSignal: init?.signal instanceof AbortSignal,
  };
}

describe("projectRefFromDbUrl", () => {
  test("reads the ref from a direct `db.<ref>.supabase.co` URL", () => {
    expect(projectRefFromDbUrl(`postgres://postgres:pw@db.${REF}.supabase.co:5432/postgres`)).toBe(
      REF,
    );
  });

  test("prefers the pooler's `postgres.<ref>` username suffix", () => {
    // A Supavisor hostname is shared across projects — SNI cannot identify the
    // tenant, so the username suffix is the only channel that names it.
    expect(
      projectRefFromDbUrl(
        `postgres://postgres.${REF}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
      ),
    ).toBe(REF);
    // Percent-encoded, exactly as `withDatabase` writes it.
    expect(
      projectRefFromDbUrl(
        `postgres://${encodeURIComponent(`postgres.${REF}`)}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
      ),
    ).toBe(REF);
  });

  test("is undefined for anything that is not a Supabase project", () => {
    // The local stack and a plain Postgres, which is what makes local dev the
    // one tier with no control plane rather than a tier with a quieter one.
    expect(projectRefFromDbUrl("postgres://postgres:pw@127.0.0.1:54322/postgres")).toBeUndefined();
    expect(projectRefFromDbUrl("postgres://postgres:pw@db:5432/postgres")).toBeUndefined();
    // A 20-character label off a Supabase domain is a hostname, not a ref:
    // guessing one would aim the control plane at an unrelated project.
    expect(
      projectRefFromDbUrl(`postgres://postgres:pw@${REF}.internal.example:5432/postgres`),
    ).toBeUndefined();
    expect(projectRefFromDbUrl("not a url")).toBeUndefined();
    // Right shape, wrong length — refs are exactly 20 characters.
    expect(
      projectRefFromDbUrl("postgres://postgres:pw@db.tooshort.supabase.co:5432/postgres"),
    ).toBeUndefined();
  });

  test("isProjectRef holds the shape the derivation and the override share", () => {
    expect(isProjectRef(REF)).toBe(true);
    expect(isProjectRef("SHOUTINGREFSHOUTING")).toBe(false);
    expect(isProjectRef("has-a-dash-in-it-xx")).toBe(false);
  });
});

describe("createSupabaseManagementApi", () => {
  test("POSTs the statement to the project's query endpoint as a bearer", async () => {
    const spy = stubFetch("[]");
    const api = createSupabaseManagementApi({
      ref: REF,
      token: "sbp_token",
      baseUrl: "https://api.example.test",
    });
    expect(await api.query('create database "app_00112233445566aa"')).toEqual([]);

    const req = requestOf(spy);
    expect(req.url).toBe(`https://api.example.test/v1/projects/${REF}/database/query`);
    expect(req.method).toBe("POST");
    expect(req.headers.get("authorization")).toBe("Bearer sbp_token");
    expect(JSON.parse(req.body)).toEqual({ query: 'create database "app_00112233445566aa"' });
    // Bounded: a control plane that never answers must not hold a deploy open.
    expect(req.hasSignal).toBe(true);
    expect(api.ref).toBe(REF);
  });

  test("reads rows, an envelope, and an empty response as no rows", async () => {
    stubFetch('[{"datname":"app_1"}]');
    expect(await createSupabaseManagementApi({ ref: REF, token: "t" }).query("select 1")).toEqual([
      { datname: "app_1" },
    ]);

    stubFetch('{"result":[{"a":1}]}');
    expect(await createSupabaseManagementApi({ ref: REF, token: "t" }).query("select 1")).toEqual([
      { a: 1 },
    ]);

    // A statement with no result set: a `create database` that SUCCEEDED must not
    // fail on the shape of its own silence.
    stubFetch("", 201, "text/plain");
    expect(
      await createSupabaseManagementApi({ ref: REF, token: "t" }).query('create database "app_1"'),
    ).toEqual([]);
  });

  test("lifts the SQLSTATE out of a failed statement, so callers read `code`", async () => {
    // `provisionAppDatabase` absorbs a lost create race by SQLSTATE. The endpoint
    // reports a SQL failure as a rendered message, and the `SQLSTATE …` token in
    // it is the machine-written part.
    stubFetch(
      JSON.stringify({
        message: 'failed to run query: ERROR: database "app_1" already exists (SQLSTATE 42P04)',
      }),
      400,
    );
    const err = await createSupabaseManagementApi({ ref: REF, token: "t" })
      .query('create database "app_1"')
      .then(
        () => null,
        (e: unknown) => e as Error & { code?: string; status?: number },
      );
    expect(err?.code).toBe("42P04");
    expect(err?.status).toBe(400);
    expect(err?.message).toContain("already exists");
    // The project is named: a control-plane failure is otherwise indistinguishable
    // from a local one in a log.
    expect(err?.message).toContain(REF);
  });

  test("honours an explicit five-character `code` field", async () => {
    stubFetch(JSON.stringify({ message: "in a transaction", code: "25001" }), 400);
    await expect(
      createSupabaseManagementApi({ ref: REF, token: "t" }).query("create database x"),
    ).rejects.toMatchObject({ code: "25001" });
  });

  test("carries NO code when the failure is not a SQL failure", async () => {
    // Fails closed: a caller absorbing `42P04` must never be handed the API's own
    // transport code, which is not a SQLSTATE at all.
    stubFetch(JSON.stringify({ message: "Unauthorized", code: "unauthorized" }), 401);
    const err = await createSupabaseManagementApi({ ref: REF, token: "t" })
      .query("select 1")
      .then(
        () => null,
        (e: unknown) => e as Error & { code?: string; status?: number },
      );
    expect(err?.code).toBeUndefined();
    expect(err?.status).toBe(401);
    expect(err?.message).toContain("401");
  });

  test("survives a non-JSON error body", async () => {
    stubFetch("<html>502 Bad Gateway</html>", 502, "text/html");
    await expect(
      createSupabaseManagementApi({ ref: REF, token: "t" }).query("select 1"),
    ).rejects.toThrow(/502/);
  });

  test("passes a transport failure through untouched", async () => {
    // No status and no SQLSTATE to add: wrapping it would only bury the cause.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch failed"));
    await expect(
      createSupabaseManagementApi({ ref: REF, token: "t" }).query("select 1"),
    ).rejects.toThrow("fetch failed");
  });

  test("never puts the token in the thrown error", async () => {
    // The token is account-wide authority, and the process safety nets
    // console.error whole error objects.
    stubFetch("boom", 500, "text/plain");
    const err = await createSupabaseManagementApi({ ref: REF, token: "sbp_supersecret" })
      .query("select 1")
      .then(
        () => null,
        (e: unknown) => e,
      );
    const rendered = `${(err as Error).message} ${JSON.stringify({ ...(err as object) })}`;
    expect(rendered).not.toContain("sbp_supersecret");
  });
});
