// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio auth statechart with no React, no supabase-js and no storage:
 * the config read and its retry, the methods read beside the session, and the
 * signed-in recovery — every path, the supabase one included, driven through
 * typed fakes of {@link StudioAuthEffects} and {@link AuthBackend}.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import type { AuthConfig } from "./api.ts";
import { GITHUB_ONLY, NO_PROVIDERS, type SignInMethods } from "./auth-methods.ts";
import {
  type AuthBackend,
  createStudioAuth,
  type SignInCredentials,
  type StudioAuthStore,
} from "./auth-state.ts";

const SUPABASE: AuthConfig = {
  mode: "supabase",
  supabaseUrl: "https://project.supabase.test",
  supabasePublishableKey: "sb_publishable_test",
};
const BOTH: SignInMethods = { github: true, password: true };

/** Let every settled promise's continuation run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A backend whose session the spec drives through `report`. */
function fakeBackend(restored: string | null = null) {
  let report: ((token: string | null) => void) | null = null;
  const refreshes: PromiseWithResolvers<string | null>[] = [];
  const backend = {
    follow: vi.fn((r: (token: string | null) => void) => {
      report = r;
      r(restored);
      return unfollow;
    }),
    signIn: vi.fn(async (_creds: SignInCredentials): Promise<string | undefined> => undefined),
    refresh: vi.fn(() => {
      const flight = Promise.withResolvers<string | null>();
      refreshes.push(flight);
      return flight.promise;
    }),
    signOut: vi.fn(),
  } satisfies AuthBackend;
  const unfollow = vi.fn();
  return {
    backend,
    unfollow,
    refreshes,
    /** The session changed, as `onAuthStateChange` reports it. */
    emit: (token: string | null) => report?.(token),
  };
}

type Fake = ReturnType<typeof fakeBackend>;

let store: StudioAuthStore | undefined;
afterEach(() => store?.stop());

/** Start a machine whose reads the spec settles by hand. */
function start(fake: Fake = fakeBackend()) {
  const configs: PromiseWithResolvers<AuthConfig>[] = [];
  const methods: PromiseWithResolvers<SignInMethods>[] = [];
  const effects = {
    readConfig: vi.fn(() => {
      const read = Promise.withResolvers<AuthConfig>();
      configs.push(read);
      return read.promise;
    }),
    readMethods: vi.fn(() => {
      const read = Promise.withResolvers<SignInMethods>();
      methods.push(read);
      return read.promise;
    }),
    connect: vi.fn(() => fake.backend),
  };
  store = createStudioAuth(effects);
  const s = store;
  return { store: s, effects, configs, methods, ...fake };
}

/** Start, and answer the config read with `config`. */
async function ready(config: AuthConfig, fake: Fake = fakeBackend()) {
  const run = start(fake);
  run.configs[0]?.resolve(config);
  await flush();
  return run;
}

/** A supabase machine past its methods read. */
async function supabaseReady(fake: Fake = fakeBackend()) {
  const run = await ready(SUPABASE, fake);
  run.methods[0]?.resolve(BOTH);
  await flush();
  return run;
}

describe("the config read", () => {
  test("is loading until the server names a flow", () => {
    const { store, effects } = start();
    expect(store.getView()).toEqual({ phase: "loading" });
    expect(effects.readConfig).toHaveBeenCalledTimes(1);
  });

  test("a failure keeps the raw error, and a retry reads again", async () => {
    const { store, effects, configs } = start();
    const error = new Error("storage exploded");
    configs[0]?.reject(error);
    await flush();
    expect(store.getView()).toEqual({ phase: "failed", error });

    store.retry();
    expect(store.getView()).toEqual({ phase: "loading" });
    expect(effects.readConfig).toHaveBeenCalledTimes(2);
    configs[1]?.resolve({ mode: "dev" });
    await flush();
    expect(store.getView()).toEqual({ phase: "signedOut", mode: "dev", methods: NO_PROVIDERS });
  });

  test("a rejection with no error still reads as a failure", async () => {
    const { store, configs } = start();
    configs[0]?.reject(undefined);
    await flush();
    const view = store.getView();
    expect(view.phase).toBe("failed");
    expect(view.phase === "failed" && view.error).toBeInstanceOf(Error);
  });

  test("a retry only follows a failure", async () => {
    const { store, effects } = start();
    store.retry();
    expect(effects.readConfig).toHaveBeenCalledTimes(1);
  });

  test("sign-in unconfigured is terminal: nothing to retry, no backend built", async () => {
    const { store, effects } = await ready({ mode: "none" });
    expect(store.getView()).toEqual({ phase: "notConfigured" });
    store.retry();
    expect(effects.readConfig).toHaveBeenCalledTimes(1);
    expect(effects.connect).not.toHaveBeenCalled();
  });

  test("an answer landing after a stop is discarded", async () => {
    const { store, configs, effects } = start();
    store.stop();
    configs[0]?.resolve({ mode: "dev" });
    await flush();
    expect(store.getView()).toEqual({ phase: "loading" });
    expect(effects.connect).not.toHaveBeenCalled();
  });
});

describe("dev mode", () => {
  test("reads no GoTrue methods and offers its own box", async () => {
    const { store, effects, backend } = await ready({ mode: "dev" });
    expect(effects.connect).toHaveBeenCalledWith({ mode: "dev" });
    expect(effects.readMethods).not.toHaveBeenCalled();
    expect(backend.follow).toHaveBeenCalledTimes(1);
    expect(store.getView()).toEqual({ phase: "signedOut", mode: "dev", methods: NO_PROVIDERS });
  });

  test("a restored token is signed in", async () => {
    const { store } = await ready({ mode: "dev" }, fakeBackend("dev.stored.dev"));
    expect(store.getView()).toEqual({ phase: "signedIn", token: "dev.stored.dev" });
  });

  test("a sign-in that settles in place hands its token back", async () => {
    const fake = fakeBackend();
    fake.backend.signIn.mockResolvedValueOnce("dev.minted.dev");
    const { store, backend } = await ready({ mode: "dev" }, fake);
    const creds: SignInCredentials = { kind: "dev", email: "me@local.test" };
    await store.signIn(creds);
    expect(backend.signIn).toHaveBeenCalledWith(creds);
    expect(store.getView()).toEqual({ phase: "signedIn", token: "dev.minted.dev" });
  });
});

describe("supabase mode", () => {
  test("a signed-out screen waits on the methods read, never shows none", async () => {
    const { store, effects, methods } = await ready(SUPABASE);
    expect(effects.readMethods).toHaveBeenCalledWith(SUPABASE);
    expect(store.getView()).toEqual({ phase: "loading" });
    methods[0]?.resolve(BOTH);
    await flush();
    expect(store.getView()).toEqual({ phase: "signedOut", mode: "supabase", methods: BOTH });
  });

  test("a failed methods read is GitHub-only", async () => {
    const { store, methods } = await ready(SUPABASE);
    methods[0]?.reject(new Error("offline"));
    await flush();
    expect(store.getView()).toEqual({
      phase: "signedOut",
      mode: "supabase",
      methods: GITHUB_ONLY,
    });
  });

  test("a restored session is signed in while the methods are still unread", async () => {
    const { store } = await ready(SUPABASE, fakeBackend("restored"));
    expect(store.getView()).toEqual({ phase: "signedIn", token: "restored" });
  });

  test("session events sign in, rotate the token and sign out", async () => {
    const { store, emit } = await supabaseReady();
    emit("first");
    expect(store.getView()).toEqual({ phase: "signedIn", token: "first" });
    emit("rotated");
    expect(store.getView()).toEqual({ phase: "signedIn", token: "rotated" });
    emit(null);
    expect(store.getView()).toEqual({ phase: "signedOut", mode: "supabase", methods: BOTH });
  });

  test("an empty token is not a session", async () => {
    const { store, emit } = await supabaseReady();
    emit("");
    expect(store.getView().phase).toBe("signedOut");
  });

  test("a sign-in whose token arrives as an event leaves the view to the event", async () => {
    const { store, emit } = await supabaseReady();
    await store.signIn({ kind: "github" });
    expect(store.getView().phase).toBe("signedOut");
    emit("from-oauth");
    expect(store.getView()).toEqual({ phase: "signedIn", token: "from-oauth" });
  });

  test("a failed sign-in rejects with the backend's error", async () => {
    const fake = fakeBackend();
    fake.backend.signIn.mockRejectedValueOnce(new Error("Invalid login credentials"));
    const { store } = await supabaseReady(fake);
    await expect(
      store.signIn({ kind: "password", email: "a@b.test", password: "nope" }),
    ).rejects.toThrow("Invalid login credentials");
    expect(store.getView().phase).toBe("signedOut");
  });

  test("signing out ends the backend's session", async () => {
    const { store, backend } = await supabaseReady(fakeBackend("live"));
    store.signOut();
    expect(backend.signOut).toHaveBeenCalledTimes(1);
    expect(store.getView().phase).toBe("signedOut");
  });

  test("a stop unsubscribes from the session", async () => {
    const { store, unfollow } = await supabaseReady();
    store.stop();
    expect(unfollow).toHaveBeenCalledTimes(1);
  });
});

describe("a rejected bearer", () => {
  test("concurrent callers share ONE refresh and one promise", async () => {
    const { store, backend, refreshes } = await supabaseReady(fakeBackend("stale"));
    const first = store.refresh();
    const second = store.refresh();
    expect(second).toBe(first);
    expect(backend.refresh).toHaveBeenCalledTimes(1);
    // Still signed in on the old bearer while the refresh is in flight.
    expect(store.getView()).toEqual({ phase: "signedIn", token: "stale" });

    refreshes[0]?.resolve("fresh");
    await first;
    expect(store.getView()).toEqual({ phase: "signedIn", token: "fresh" });

    // The flight is over, so the next rejection starts another.
    void store.refresh();
    expect(backend.refresh).toHaveBeenCalledTimes(2);
  });

  test("a refresh with no session left signs out", async () => {
    const { store, refreshes } = await supabaseReady(fakeBackend("stale"));
    const flight = store.refresh();
    refreshes[0]?.resolve(null);
    await flight;
    expect(store.getView().phase).toBe("signedOut");
  });

  test("a refresh that throws signs out", async () => {
    const { store, refreshes } = await supabaseReady(fakeBackend("stale"));
    const flight = store.refresh();
    refreshes[0]?.reject(new Error("network"));
    await flight;
    expect(store.getView().phase).toBe("signedOut");
  });

  test("a sign-out event mid-refresh settles the flight", async () => {
    const { store, emit } = await supabaseReady(fakeBackend("stale"));
    const flight = store.refresh();
    emit(null);
    await flight;
    expect(store.getView().phase).toBe("signedOut");
  });

  test("a rotated token mid-refresh is kept, and the refresh's answer wins", async () => {
    const { store, emit, refreshes } = await supabaseReady(fakeBackend("stale"));
    const flight = store.refresh();
    emit("rotated");
    expect(store.getView()).toEqual({ phase: "signedIn", token: "rotated" });
    refreshes[0]?.resolve("refreshed");
    await flight;
    expect(store.getView()).toEqual({ phase: "signedIn", token: "refreshed" });
  });

  test("with no bearer there is nothing to refresh", async () => {
    const { store, backend } = await supabaseReady();
    await store.refresh();
    expect(backend.refresh).not.toHaveBeenCalled();
  });

  test("a stop mid-refresh settles the flight", async () => {
    const { store } = await supabaseReady(fakeBackend("stale"));
    const flight = store.refresh();
    store.stop();
    await expect(flight).resolves.toBeUndefined();
  });
});

describe("the view", () => {
  test("is the same object until a field changes", async () => {
    const { store, emit } = await supabaseReady(fakeBackend("token"));
    const before = store.getView();
    expect(store.getView()).toBe(before);
    emit("token");
    expect(store.getView()).toBe(before);
    emit("other");
    expect(store.getView()).not.toBe(before);
  });

  test.each([
    ["failed", (run: ReturnType<typeof start>) => run.configs[0]?.reject(new Error("down"))],
    ["signedOut", (run: ReturnType<typeof start>) => run.configs[0]?.resolve({ mode: "dev" })],
  ])("a %s view is stable across reads", async (phase, settle) => {
    const run = start();
    settle(run);
    await flush();
    const before = run.store.getView();
    expect(before.phase).toBe(phase);
    expect(run.store.getView()).toBe(before);
  });

  test("notifies subscribers, and stops on unsubscribe", async () => {
    const { store, emit } = await supabaseReady();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    emit("token");
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    unsubscribe();
    emit(null);
    expect(listener).not.toHaveBeenCalled();
  });

  test("signing in before any backend exists is a no-op", async () => {
    const { store } = start();
    await expect(store.signIn({ kind: "github" })).resolves.toBeUndefined();
  });
});
