/**
 * The OWNERSHIP and HYGIENE line rules — 5, 8, 9, 11 and 16.
 *
 * What they have in common is that each one is about state somebody else owns:
 * the process environment (5), a map entry another async continuation may have
 * replaced (8, 9), a filesystem path that belongs to a different machine (11),
 * and the session's observable surface (16).
 *
 * Rule 6 is RETIRED and rule 15 is RESERVED; both numbers stay unused. Rule IDs
 * are STABLE across the split from `guard-invariants-rules.mjs`.
 */

import {
  AT_LINE_START,
  DECLARES,
  IDENT,
  MAP_GET,
  MEMBER,
  ON_NAME,
} from "./guard-invariants-ere.mjs";
import {
  SESSION_SURFACE_PATHS,
  SOURCE_PATHSPECS,
  TMP_RULE_PATHSPECS,
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
    paths: TMP_RULE_PATHSPECS,
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
      "`slot.update` for the ctx.state case. The parts that get missed are\n" +
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
      "Add the EVENT to `packages/aai/sdk/protocol-events.ts` and report it —\n" +
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
      "So a new capability is a DESIGN decision, not a field: give it its own\n" +
      "capability root under `contracts/entrypoints/`, and reach it through an\n" +
      "existing field rather than a new one. This is the same rule as 16 for\n" +
      "session callbacks, one layer up.\n\n" +
      "The nine baselined occurrences are the fields that exist. Lowering the\n" +
      "budget means one came OUT, which is the direction this moves.",
  },
];
