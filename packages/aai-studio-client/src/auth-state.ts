// Copyright 2026 the AAI authors. MIT license.
/**
 * `useStudioAuth`'s decisions as a statechart, with no React, no supabase-js
 * and no storage: which config the server named, whether the sign-in screen
 * knows its methods yet, and whether a bearer is held, being refreshed, or
 * gone. The hook supplies {@link StudioAuthEffects} (the config read, the
 * GoTrue methods read, and a {@link AuthBackend} per mode), so
 * `auth-state.test.ts` specs every path — the supabase one included — with
 * typed fakes.
 *
 * ```
 * loadingConfig ─┬─ failed ──RETRY──▶ loadingConfig
 *                ├─ notConfigured                     (mode "none": nothing to retry)
 *                └─ ready (parallel, follows the backend's session)
 *                     methods: pending → reading → read   (dev: straight to read)
 *                     session: signedOut ⇄ signedIn { idle ──REJECTED──▶ refreshing }
 * ```
 *
 * The two `ready` regions move independently because the old hook's facts
 * did: a RESTORED session is signed in while GoTrue's methods are still being
 * read, and only a signed-out view waits on them (as `loading`, never as a
 * card with no buttons).
 *
 * Every read is a `fromPromise` invoke, so leaving its state (a retry, a stop)
 * discards its answer — that is what replaces a generation counter. The
 * refresh is one too, and `signedIn.refreshing` IS the single flight: a second
 * `REJECTED` while it runs is not an event that state takes, and every caller
 * of {@link StudioAuthStore.refresh} during one flight gets the same promise.
 */

import { assign, createActor, fromCallback, fromPromise, setup } from "xstate";
import type { AuthConfig } from "./api.ts";
import { GITHUB_ONLY, NO_PROVIDERS, type SignInMethods } from "./auth-methods.ts";

/**
 * What a sign-in attempt supplies, which is different per method.
 *
 * A discriminated union rather than one `(email?, password?)` signature: with
 * the latter, "GitHub ignores both arguments" and "sign-up needs both" are
 * comments instead of types, and the gate has to be trusted to pass the right
 * subset. Sign-up is its own member rather than a fallback inside password
 * sign-in, because silently creating an account for a MISTYPED password is a
 * failure the user cannot see.
 */
export type SignInCredentials =
  | { kind: "github" }
  | { kind: "password"; email: string; password: string }
  | { kind: "signup"; email: string; password: string }
  | { kind: "dev"; email: string };

/** The configs that can sign anybody in. */
export type SupabaseAuthConfig = Extract<AuthConfig, { mode: "supabase" }>;
export type SignInAuthConfig = Extract<AuthConfig, { mode: "supabase" | "dev" }>;

/** One mode's session: where tokens come from and how they are recovered. */
export type AuthBackend = {
  /**
   * Follow the session: report the restored token (or `null`) and every
   * change after it. Returns the unsubscribe, run when the machine stops.
   */
  follow(report: (token: string | null) => void): () => void;
  /**
   * Start a sign-in. Resolves with a token when the method settles in place
   * WITHOUT a session event (dev mode); otherwise the token arrives through
   * {@link follow}. Rejects with the sentence to show.
   */
  signIn(creds: SignInCredentials): Promise<string | undefined>;
  /**
   * The server rejected the bearer: mint a fresh one, or resolve `null` when
   * the session is over (and has been dropped, so a reload cannot restore it).
   */
  refresh(): Promise<string | null>;
  /** End the session. */
  signOut(): void;
};

/** What the machine needs and cannot do itself. */
export type StudioAuthEffects = {
  /** `GET /studio/auth`. */
  readConfig(): Promise<AuthConfig>;
  /** Which methods GoTrue has enabled. Expected never to reject. */
  readMethods(config: SupabaseAuthConfig): Promise<SignInMethods>;
  /** Build the backend for a config that can sign in. Called once per config. */
  connect(config: SignInAuthConfig): AuthBackend;
};

/** Everything that moves the machine from outside. */
export type StudioAuthEvent =
  /** Read the config again, after a failed read. */
  | { type: "RETRY" }
  /** The backend's session changed (or a sign-in settled in place). */
  | { type: "TOKEN"; token: string | null }
  /** The user signed out. */
  | { type: "SIGN_OUT" }
  /** The server rejected the current bearer. */
  | { type: "REJECTED" };

type Context = {
  effects: StudioAuthEffects;
  config: SignInAuthConfig | null;
  backend: AuthBackend | null;
  configError: unknown;
  /** `null` while GoTrue's answer is unread. */
  methods: SignInMethods | null;
  token: string | null;
};

/** The backend `ready` holds — assigned on the transition into it. */
function backendOf(context: Context): AuthBackend {
  if (!context.backend) throw new Error("studio auth: no backend outside `ready`");
  return context.backend;
}

const machine = setup({
  types: {} as {
    context: Context;
    input: { effects: StudioAuthEffects };
    events: StudioAuthEvent;
  },
  actors: {
    readConfig: fromPromise<AuthConfig, StudioAuthEffects>(({ input }) => input.readConfig()),
    readMethods: fromPromise<
      SignInMethods,
      { effects: StudioAuthEffects; config: SupabaseAuthConfig }
    >(({ input }) => input.effects.readMethods(input.config)),
    follow: fromCallback<StudioAuthEvent, AuthBackend>(({ input, sendBack }) =>
      input.follow((token) => sendBack({ type: "TOKEN", token })),
    ),
    refresh: fromPromise<string | null, AuthBackend>(({ input }) => input.refresh()),
  },
  actions: {
    signOut: ({ context }) => context.backend?.signOut(),
    setToken: assign({
      token: ({ event }) => (event.type === "TOKEN" ? event.token : null),
    }),
    clearToken: assign({ token: null }),
  },
  guards: {
    supabase: ({ context }) => context.config?.mode === "supabase",
    // An EMPTY token is not a session, as the old `if (token)` had it.
    hasToken: ({ event }) => event.type === "TOKEN" && Boolean(event.token),
  },
}).createMachine({
  id: "studioAuth",
  initial: "loadingConfig",
  context: ({ input }) => ({
    effects: input.effects,
    config: null,
    backend: null,
    configError: null,
    methods: null,
    token: null,
  }),
  states: {
    loadingConfig: {
      invoke: {
        src: "readConfig",
        input: ({ context }) => context.effects,
        onDone: [
          { guard: ({ event }) => event.output.mode === "none", target: "notConfigured" },
          {
            target: "ready",
            actions: assign(({ context, event }) => {
              // `none` was the guard above, so this config can sign in.
              const config = event.output as SignInAuthConfig;
              return { config, backend: context.effects.connect(config) };
            }),
          },
        ],
        onError: {
          target: "failed",
          // The raw error, not its text: the gate words itself from the
          // error's KIND (a busy server reads differently from a broken one).
          actions: assign({
            configError: ({ event }) => event.error ?? new Error("Could not reach the server"),
          }),
        },
      },
    },
    failed: {
      on: { RETRY: { target: "loadingConfig", actions: assign({ configError: null }) } },
    },
    // The server answered that sign-in is not configured: a second read cannot
    // change that, so this state takes no events.
    notConfigured: {},
    ready: {
      type: "parallel",
      invoke: {
        src: "follow",
        input: ({ context }) => backendOf(context),
      },
      states: {
        methods: {
          initial: "pending",
          states: {
            // A `dev` server has one method and it is not GoTrue's.
            pending: {
              always: [
                { guard: "supabase", target: "reading" },
                { target: "read", actions: assign({ methods: NO_PROVIDERS }) },
              ],
            },
            reading: {
              invoke: {
                src: "readMethods",
                input: ({ context }) => ({
                  effects: context.effects,
                  config: context.config as SupabaseAuthConfig,
                }),
                onDone: {
                  target: "read",
                  actions: assign({ methods: ({ event }) => event.output }),
                },
                // `readSignInMethods` never rejects; an effect that does gets the
                // same answer its own failures do — an unknown answer is
                // GitHub-only, never nothing.
                onError: { target: "read", actions: assign({ methods: GITHUB_ONLY }) },
              },
            },
            read: {},
          },
        },
        session: {
          initial: "signedOut",
          states: {
            signedOut: {
              on: { TOKEN: { guard: "hasToken", target: "signedIn", actions: "setToken" } },
            },
            signedIn: {
              initial: "idle",
              on: {
                TOKEN: [
                  { guard: "hasToken", actions: "setToken" },
                  { target: "signedOut", actions: "clearToken" },
                ],
                SIGN_OUT: { target: "signedOut", actions: ["signOut", "clearToken"] },
              },
              states: {
                idle: { on: { REJECTED: "refreshing" } },
                refreshing: {
                  invoke: {
                    src: "refresh",
                    input: ({ context }) => backendOf(context),
                    onDone: [
                      {
                        guard: ({ event }) => Boolean(event.output),
                        target: "idle",
                        actions: assign({ token: ({ event }) => event.output }),
                      },
                      { target: "#studioAuth.ready.session.signedOut", actions: "clearToken" },
                    ],
                    onError: {
                      target: "#studioAuth.ready.session.signedOut",
                      actions: "clearToken",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

/** What the hook renders from. A new object only when a field changes. */
export type StudioAuthView =
  | { phase: "loading" }
  | { phase: "failed"; error: unknown }
  | { phase: "notConfigured" }
  | { phase: "signedOut"; mode: SignInAuthConfig["mode"]; methods: SignInMethods }
  | { phase: "signedIn"; token: string };

/** The view before any machine runs. */
export const LOADING_VIEW: StudioAuthView = { phase: "loading" };

/** One running machine: read and subscribe to its view, act on it, stop it. */
export type StudioAuthStore = {
  getView(): StudioAuthView;
  subscribe(listener: () => void): () => void;
  /** Read the config again. A no-op unless the last read failed. */
  retry(): void;
  /** Sign in with whatever the method needs. A no-op before a backend exists. */
  signIn(creds: SignInCredentials): Promise<void>;
  signOut(): void;
  /**
   * The server rejected the bearer: recover it or sign out. Settles when the
   * refresh does; concurrent callers share ONE refresh and one promise.
   */
  refresh(): Promise<void>;
  stop(): void;
};

function sameView(a: StudioAuthView, b: StudioAuthView): boolean {
  if (a.phase !== b.phase) return false;
  switch (a.phase) {
    case "failed":
      return a.error === (b as typeof a).error;
    case "signedIn":
      return a.token === (b as typeof a).token;
    case "signedOut":
      return a.mode === (b as typeof a).mode && a.methods === (b as typeof a).methods;
    default:
      return true;
  }
}

/** Start a machine over `effects`. */
export function createStudioAuth(effects: StudioAuthEffects): StudioAuthStore {
  const actor = createActor(machine, { input: { effects } });
  let view: StudioAuthView = LOADING_VIEW;
  const read = (): StudioAuthView => {
    const at = actor.getSnapshot();
    const { config, configError, methods, token } = at.context;
    let next: StudioAuthView;
    if (at.matches("failed")) next = { phase: "failed", error: configError };
    else if (at.matches("notConfigured")) next = { phase: "notConfigured" };
    else if (config && token && at.matches({ ready: { session: "signedIn" } })) {
      next = { phase: "signedIn", token };
    } else if (config && methods && at.matches({ ready: { session: "signedOut" } })) {
      next = { phase: "signedOut", mode: config.mode, methods };
    } else next = LOADING_VIEW;
    if (!sameView(view, next)) view = next;
    return view;
  };

  // The flight in progress, so every caller during it shares one promise.
  let flight: PromiseWithResolvers<void> | null = null;
  const settleFlight = (): void => {
    flight?.resolve();
    flight = null;
  };
  actor.subscribe(() => {
    const flying = actor.getSnapshot().matches({ ready: { session: { signedIn: "refreshing" } } });
    if (flying) flight ??= Promise.withResolvers<void>();
    else settleFlight();
  });
  actor.start();

  return {
    getView: read,
    subscribe(listener) {
      const sub = actor.subscribe(() => listener());
      return () => sub.unsubscribe();
    },
    retry: () => actor.send({ type: "RETRY" }),
    async signIn(creds) {
      const { backend } = actor.getSnapshot().context;
      if (!backend) return;
      const token = await backend.signIn(creds);
      if (token !== undefined) actor.send({ type: "TOKEN", token });
    },
    signOut: () => actor.send({ type: "SIGN_OUT" }),
    refresh() {
      actor.send({ type: "REJECTED" });
      return flight?.promise ?? Promise.resolve();
    },
    stop() {
      actor.stop();
      settleFlight();
    },
  };
}
