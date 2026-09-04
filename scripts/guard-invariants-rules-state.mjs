/**
 * The OWNERSHIP and HYGIENE line rules — 5, 8, 9, 11, 16 and 27.
 *
 * What they have in common is that each one is about state somebody else owns:
 * the process environment (5), a map entry another async continuation may have
 * replaced (8, 9), a filesystem path that belongs to a different machine (11),
 * the session's observable surface (16), and a resource whose lifetime belongs
 * to a scope rather than to whoever remembered to release it (27).
 *
 * Rule 6 is RETIRED and rule 15 is RESERVED; both numbers stay unused. Rule IDs
 * are STABLE across the split from `guard-invariants-rules.mjs`.
 */

import {
  AT_LINE_START,
  DECLARES,
  DISPOSE_CALL,
  IDENT,
  MAP_GET,
  MEMBER,
  ON_NAME,
} from "./guard-invariants-ere.mjs";
import {
  CHANNEL_MESSAGE_PATHS,
  RUNTIME_EGRESS_PATHSPECS,
  SESSION_SURFACE_PATHS,
  SHIPPED_SOURCE_PATHSPECS,
  SOURCE_PATHSPECS,
  TOOL_CONTEXT_PATHS,
} from "./guard-invariants-scopes.mjs";

/** @type {import("./guard-invariants-rules.mjs").LineRule[]} */
export const STATE_RULES = [
  {
    id: 5,
    key: "rule5_deleteProcessEnv",
    label: "delete process.env",
    re: "delete process\\.env",
    paths: SOURCE_PATHSPECS,
    skipComments: true,
    remedy:
      "Use `vi.stubEnv(name, undefined)`. `unstubEnvs` (set in\n" +
      "vitest.shared.ts) reverses it before each test, so there is nothing to\n" +
      "restore by hand — and a hand-rolled restore is what rots: deepgram.test.ts\n" +
      'wrote back a captured `undefined`, which env coercion turns into "undefined".',
  },
  // Rule 6 is RETIRED: `ctx.state` no longer exists, so `ctx.state as T` is
  // unrepresentable rather than discouraged. It banned that cast in a template,
  // on the finding that all five stateful ones had taken it — a tool learned the
  // state shape only from an annotated context, so a second module either
  // restated the annotation or cast. Session state is a `sessionSlot` now, which
  // types and stores its own value in the module that declares it, and there is
  // no bag left to cast.
  //
  // The NUMBER stays retired rather than being reused, per this file's stable-id
  // rule: 6 appears in commit messages and in the baseline's history, and a later
  // rule inheriting it would make both misleading.
  {
    id: 11,
    key: "rule11_hardcodedTmp",
    label: "hardcoded /tmp path",
    // A `/tmp/...` string literal. `"` and a backtick both start one here.
    re: '["`]/tmp/',
    // SHIPPED source only. The hazard is a real filesystem write, and a spec
    // handing `"/tmp/watched"` to a fake chokidar never touches the disk — eight
    // files' worth of those made the first draft of this rule pure noise.
    paths: SHIPPED_SOURCE_PATHSPECS,
    skipComments: true,
    remedy:
      "Use `join(tmpdir(), …)` from node:os + node:path.\n" +
      "On Windows a bare `/tmp/x` is DRIVE-RELATIVE — it resolves to `D:\\tmp\\x`,\n" +
      "which does not exist — so every write there fails with ENOENT. Two shipped\n" +
      "modules had it (`workflow-serve.ts`, `harness-bundle.ts`) and both run on\n" +
      "the developer's own machine under `aai dev`, not only in the Linux guest.\n" +
      "Baseline an occurrence only when the path is INSIDE a container by\n" +
      "construction — `modal-agent-sandbox.ts`'s remote paths name a location in\n" +
      "the Linux sandbox, where `/tmp` is the correct literal and `tmpdir()` would\n" +
      "wrongly describe the host.",
  },
  {
    id: 8,
    key: "rule8_handRolledOwnedMap",
    label: "hand-rolled owned-map eviction",
    re: `${MAP_GET} === ${IDENT}\\) ${MEMBER}\\.delete\\(`,
    paths: SOURCE_PATHSPECS,
    skipComments: true,
    remedy:
      "Use `createOwnedMap()` from @alexkroman1/aai/internal. `claim(key, value)`\n" +
      "returns the only release for that claim, so an async teardown settling\n" +
      "after the key was re-claimed (reconnect resume, redeploy) cannot evict\n" +
      "the successor's entry.",
  },
  {
    id: 9,
    key: "rule9_handRolledKeyedLock",
    label: "hand-rolled per-key promise chain",
    re: `${MAP_GET} \\?\\? Promise\\.resolve\\(\\)`,
    paths: SOURCE_PATHSPECS,
    skipComments: true,
    remedy:
      "Use `createKeyedLock()` / `withLock()` from @alexkroman1/aai, or\n" +
      "`slot.update` for a session slot. The parts that get missed are\n" +
      "dropping the drained entry BY OWNERSHIP and resolving your own place in\n" +
      "the chain when you abandon a timed-out acquire.",
  },
  {
    id: 16,
    key: "rule16_sessionCallbackName",
    label: "session callback name (report an event)",
    re: `${AT_LINE_START}${ON_NAME}${DECLARES}`,
    paths: SESSION_SURFACE_PATHS,
    skipComments: true,
    remedy:
      "Add the EVENT to `packages/aai/src/sdk/protocol-events.ts` and report it —\n" +
      "`SessionCore.report(event)` and `TransportCallbacks.report(event)` take the\n" +
      "protocol's own vocabulary, so a new thing the session observes costs one\n" +
      "union member and one `case`. A new `on*` costs a declaration on the type, a\n" +
      "forward in `runtime-session-callbacks.ts`, and a stub in each of the four\n" +
      "harnesses that stand in for the thing that fires it — which is the\n" +
      "multiplier that put 157 of these across eleven files.\n\n" +
      "A name is legitimate exactly when there IS NO EVENT for it, and every\n" +
      "baselined occurrence is one of three kinds:\n" +
      "  - BINARY AUDIO (`onAudio`, `onAudioChunk`). 384 kbps of PCM, deliberately\n" +
      "    outside the event vocabulary — see `protocol-events.ts`, and note the\n" +
      "    retained stream is why: audio in it would be minutes of samples per call\n" +
      "    in the tenant's own Postgres.\n" +
      "  - NO EVENT EXISTS (`onReplyStarted` — the wire has `reply.completed` and\n" +
      "    `reply.cancelled` and no `reply.started`; `onSessionReady` — a provider's\n" +
      "    own resume token, which nothing on the wire describes).\n" +
      "  - LIFECYCLE THE CALLER MUST ACT ON (`onOpen`/`onClose`/`onSessionEnd`/\n" +
      "    `onSinkCreated`/`onToolResult`). These release state or settle a pending\n" +
      "    call; an observe-only hook could not, which is the same distinction\n" +
      "    `SessionEventContext` draws by carrying no `send`.\n\n" +
      "Minting an event to dodge this rule is worse than the callback: an event is\n" +
      "AUTHOR-VISIBLE (`agent({ events })`) and retained, so it is a promise.",
  },
  {
    id: 24,
    key: "rule24_toolContextField",
    label: "field on ToolContext (the capability bag grows)",
    re: `${AT_LINE_START}${IDENT}${DECLARES}`,
    paths: TOOL_CONTEXT_PATHS,
    skipComments: true,
    samples: {
      matches: ["  db: Db;", "  send(event: string, data: unknown): void;"],
      ignores: ["   * `ctx.db` is the database.", "export type ToolContext = {"],
    },
    remedy:
      "`ToolContext` is the one type every tool body reads, and it has grown a\n" +
      "field per runtime capability — `db`, then `generate`, then `workflows`.\n" +
      "Its own module doc says so. That growth is the single largest source of\n" +
      "SIGNATURE-ONLY contract churn in this repo: `aai:tool` ran NINE\n" +
      "consecutive epochs (v3-v11) at a constant 17 exports, every one a forced\n" +
      "classification for a type the capability does not name.\n\n" +
      "A rollup follows every type a signature reaches, so the shape of\n" +
      "whatever you add lands in the tool-authoring contract AND in\n" +
      "`/testing`'s — moving the name to another capability does not change\n" +
      "that, because API Extractor rolls up FORGOTTEN exports (`Db` is in\n" +
      "`etc/testing.api.md` today under a bare `type Db = {`).\n\n" +
      "So the bar is high, and it is a DESIGN decision rather than a field. A\n" +
      "field here is a capability the runtime must supply on every tool call, on\n" +
      "every host and in every test double — a promise, not a convenience. It\n" +
      "earns one only if it is per-CALL and cannot be reached any other way:\n" +
      "anything an author can get from a value they already hold belongs in that\n" +
      "value's own module, with its own capability root under\n" +
      "`contracts/entrypoints/`. This is rule 16 for session callbacks, one\n" +
      "layer up, and rule 25 for the channel message shape is its sibling.\n\n" +
      "Raising the budget is allowed and is meant to cost something: write the\n" +
      "argument in the field's own doc, the way `delegate` does — the tenth, and\n" +
      "the one that moved this from nine. Lowering it means a capability came\n" +
      "OUT, which is the direction this moves.",
  },
  {
    id: 25,
    key: "rule25_channelMessageField",
    label: "field on the shared channel message shape",
    re: `${AT_LINE_START}(readonly )?${IDENT}${DECLARES}`,
    paths: CHANNEL_MESSAGE_PATHS,
    skipComments: true,
    samples: {
      matches: ["  readonly title?: string;", "  readonly kind: string;"],
      ignores: ["   * `title` is the headline.", "export interface ChannelSection {"],
    },
    remedy:
      "`ChannelMessage` and `ChannelSection` are the platform-NEUTRAL half of a\n" +
      "channel, and the half `aai:channels`' contract hash watches. A field added\n" +
      "here is a signature change for every channel kind, including the ones that\n" +
      "cannot render it — so a Slack-only affordance charges a version bump to\n" +
      "Discord, to Teams, and to whatever is added next.\n\n" +
      "A knob only one platform has belongs in that kind's OWN options type,\n" +
      "which nothing else reads and which is free to grow. `textParam` is the\n" +
      "worked example: a Slack workflow-trigger detail on `SlackChannelOptions`,\n" +
      "invisible to this file and to every other channel.\n\n" +
      "This is rule 24 one layer up, and for the same reason: `ToolContext` grew\n" +
      "a field per runtime capability and `aai:tool` ran NINE consecutive\n" +
      "signature-only epochs for it. Add here only what a new channel would have\n" +
      "to INVENT to render at all.",
  },
  {
    id: 27,
    key: "rule27_explicitDisposeCall",
    label: "explicit Symbol.dispose call (bind it with `using`)",
    re: DISPOSE_CALL,
    // SHIPPED source only. In a spec the dispose call is routinely the SUBJECT
    // or a stimulus rather than a teardown — see SHIPPED_SOURCE_PATHSPECS.
    paths: SHIPPED_SOURCE_PATHSPECS,
    skipComments: true,
    samples: {
      matches: [
        "      await warm[Symbol.asyncDispose]();",
        "    core[Symbol.dispose]();",
        "    await entry.warm[Symbol.asyncDispose]();",
      ],
      ignores: [
        // Every DECLARATION spelling. The protocol is what the rule wants more
        // of, so a pattern that could not tell these from a call would ban it.
        "    async [Symbol.asyncDispose]() {",
        "  [Symbol.dispose](): void;",
        "    [Symbol.asyncDispose]: async () => {",
        // A reference that is not a call.
        "    expect(core[Symbol.dispose]).not.toHaveBeenCalled();",
      ],
    },
    remedy:
      "Bind the resource with `using` / `await using` and let scope exit\n" +
      "dispose it.\n\n" +
      "When ownership is CONDITIONAL — dispose on every exit but the one that\n" +
      "hands the resource on — bind an AsyncDisposableStack instead, register\n" +
      "the resource with its use method, and call move on the success path so\n" +
      "that scope exit leaves it alone. See installOrDispose in\n" +
      "packages/aai-studio-server/src/studio-session-ensure.ts.\n\n" +
      "The repo implemented the protocol and then called it by hand: three\n" +
      "modules declare `[Symbol.asyncDispose]` and every consumer invoked it as\n" +
      "an ordinary method, so the language feature that exists to make teardown\n" +
      "unforgettable was doing none of that work. `studio-session-ensure.ts`'s\n" +
      "`installOrDispose` is the shape that argues it: the invariant is 'dispose\n" +
      "on every exit EXCEPT the installed one', which `try`/`catch` cannot spell\n" +
      "once — the success path returns from inside the `try`, so the disposal was\n" +
      "written twice and a third exit added anywhere in the body would have\n" +
      "leaked a billed Modal sandbox in silence.\n\n" +
      "Baseline an occurrence only when the call is NOT a scope guard, and say so\n" +
      "at the line. Two are:\n" +
      "  - `studio-session-idle.ts`'s `disposeEntry`, whose whole PURPOSE is\n" +
      "    disposal — it releases an entry the session map owns, and `using`\n" +
      "    cannot express 'dispose a resource acquired in another scope'.\n" +
      "  - `define-client.tsx`'s `() => session[Symbol.dispose]()`, a teardown\n" +
      "    thunk handed to the React root. A callback is not a scope either.",
  },
  {
    id: 29,
    key: "rule29_globalFetchInRuntime",
    label: "globalThis.fetch as a runtime egress default",
    // The FALLBACK expression, never the type. `fetch?: typeof globalThis.fetch`
    // is how every one of these modules declares its test seam and is correct —
    // what this bans is that seam's DEFAULT. `typeof ` sits immediately before
    // the member expression in the type form, so neither alternative can reach
    // it: ERE has no lookbehind, and none is needed.
    re: '(\\?\\?|\\|\\|) *globalThis\\.fetch|= *globalThis\\.fetch[^"]',
    paths: RUNTIME_EGRESS_PATHSPECS,
    skipComments: true,
    samples: {
      matches: [
        "  const call = opts.fetch ?? globalThis.fetch;",
        "  const fetchFn = opts.fetch || globalThis.fetch;",
        "  const doFetch = globalThis.fetch;",
      ],
      ignores: [
        "  const call = opts.fetch ?? blobFetch;",
        // The TYPE, which every one of these seams declares and must keep.
        "  fetch?: typeof globalThis.fetch | undefined;",
        "export const rpcFetch: typeof globalThis.fetch = (input, init) =>",
      ],
    },
    remedy:
      "Use `rpcFetch` (a platform RPC) or `blobFetch` (bytes) from\n" +
      "./_egress-fetch.ts — two pools, because a kilobyte of JSON and an 8 MiB\n" +
      "window are not the same traffic and must not compete for one pool's\n" +
      "sockets. That module's doc carries the split.\n" +
      "\n" +
      "undici 8 — the copy backing `globalThis.fetch` from Node 26 — defaults\n" +
      "`allowH2` to TRUE, so every concurrent request this process makes to one\n" +
      "origin is multiplexed onto ONE TCP connection sharing one flow-control\n" +
      "window. A capacity limit then arrives as a STREAM RESET, which carries no\n" +
      "HTTP status at all: `TypeError: fetch failed`, for everything in flight.\n" +
      "`sdk/step-fetch.ts` measured it — 14 of 16 concurrent 17.66 MB requests\n" +
      "landed on the global against 16/16 on HTTP/1.1 — and fixed it for a STEP's\n" +
      "outbound call. This rule exists because that left FIVE call sites in this\n" +
      "package on the global, and they are the same shape: 32 concurrent bucket\n" +
      "probes per part claim, a workflow's window reads, and a run-event stream\n" +
      "held open across all of it.\n" +
      "\n" +
      "What that cost in production, on one 64 MB upload: six consecutive\n" +
      "`PUT …/workflows/uploads/<id>/parts -> 500`, ~40s each, interleaved with\n" +
      "`Workflow run event read failed { error: 'fetch failed' }` on an unrelated\n" +
      "route in the same instant — one transport fault reading as three bugs. The\n" +
      "byte path's own retry could not help: re-issuing in lockstep onto the\n" +
      "connection that just reset IS the failure.\n" +
      "\n" +
      "Keep the `fetch?: typeof globalThis.fetch` seam — a caller passing one\n" +
      "still wins, which is what a spec uses. Only the DEFAULT is the bug.\n" +
      "\n" +
      "Baseline an occurrence only where the pooled fetch would be WRONG, not\n" +
      "merely unnecessary. `providers/_openai-stream-repair.ts` is the standing\n" +
      "entry: it wraps a caller-supplied provider fetch, resolves the global per\n" +
      "call so a spec can stub it, and builds a `Headers`/`Response` from the\n" +
      "ambient realm — which undici 8 brand-checks against its own classes (see\n" +
      "`host/_undici.ts`). Its origin is a model provider, one streaming call a\n" +
      "turn, not a fan-out.",
  },
];
