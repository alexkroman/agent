---
summary: >-
  aai-runtime's durable-workflow half: journal selection, webhook URLs, the
  public vs platform base URL, and the typed-JSON codec's escape
read_when: >-
  editing anything under `src/workflow/`
---

# aai-runtime workflows

The journal, the replay engine and their tests are reference in
[`../../JOURNAL-CLAUDE.md`](../../JOURNAL-CLAUDE.md) — read it when working on
the journal, a backend or the engine's walk. HTTP status rules are in
[`api/CLAUDE.md`](api/CLAUDE.md). The run context is `Symbol.for`-keyed; see
"A deployed guest has TWO copies of this package" in the package guide.

## A run's journal has THREE homes, and the order between them is a decision

`selectJournal` (`runtime.ts`) picks **platform, then postgres, then memory**,
and the boot line names the winner.

- **Platform first**: a deployed guest has no tenant database, and journaling
  into the sandbox dies with it after `AGENT_IDLE_EXIT_MS`.
- **Memory is last and the boot line SAYS so** — a durability tradeoff absent
  from the log reads as a bug.
- **The platform pair is read from THIS PROCESS's environment**
  (`platformGuestOptions`), never the agent's: an agent may set any `AAI_*` key
  as a secret and would otherwise choose where its journal is sent.

## A callback URL comes from `publicWebhookUrl`, and the route is on `createRuntimeServer`

`ctx.workflows.publicWebhookUrl(token)` mints the one workflow URL that LEAVES
the system: `RuntimeOptions.publicUrl` + `WORKFLOW_WEBHOOK_PREFIX`, the constant
the router parses, so they cannot drift.

- **The route hangs off `createRuntimeServer`**, which every door goes through
  (`aai dev`, `server.mjs`, the guest) — never off a build artifact. A missing
  route is invisible: the run looks healthily suspended.
- **It reads `runtime.workflows` through a LAZY getter** — the guest builds its
  runtime on first need.
- **A `false` from `WorkflowClient.signal` is a 404, never a 5xx** — the caller
  is a third party whose retry loop reads 5xx as "come back"
  (`webhook.ts`; `http-adapter.ts` takes the failure status as a parameter).
- **`publicUrl` is an OPTION, never sniffed**: the platform passes
  `AAI_PUBLIC_BASE_URL` through the harness, `server.mjs` reads `PUBLIC_URL`,
  `aai dev` passes its BACKEND origin (Vite does not proxy `/.well-known/`).
  Never read an `AAI_*` variable here.
- **Unconfigured THROWS**, naming the option — never a `localhost` URL.
- **It takes the token, because a hook's token is the caller's.** Derive it in
  one exported helper the body and tool both import; a URL minted from a TOOL
  wants `createHook({ token })`, not `createWebhook()`.
- **Bodies and steps** use `stepWebhookUrl(token)` (`@alexkroman1/aai/step`),
  which reads a `Symbol.for` slot filled with a MINTER by
  `publishWorkflowWebhookUrl(publicUrl)` (`serve.ts`) — the one place base +
  prefix + encoded token are composed. The guest publishes at bundle load; an
  unfilled slot THROWS (`aai dev` does not publish one yet). `client.ts`'s
  inline composition still owes a fold onto `workflowWebhookUrl`.

## `AAI_PUBLIC_BASE_URL` is what a THIRD PARTY dials, not what the guest dials

`resolvePlatformQueue` (`platform-world.ts`) resolves the base every platform
client here POSTs to (run storage, queue, session state, upload records) from
**`AAI_PLATFORM_BASE_URL`**, falling back to `AAI_PUBLIC_BASE_URL`.

| | `AAI_PUBLIC_BASE_URL` | `AAI_PLATFORM_BASE_URL` |
| --- | --- | --- |
| Claim | "a third party reaches this agent here" | "the platform is dialable here" |
| Reader | `publicUrl` → `publicWebhookUrl` | `resolvePlatformQueue` |
| Must resolve from | the internet | **inside the sandbox** |

- They differ under `microsandbox` (the guest's own `127.0.0.1:8080` is not the
  platform). Never rewrite the public key to a sandbox alias — webhook URLs
  would become unreachable. The platform derives the second key
  (`agentPlatformBaseUrl` in `aai-server/public-origin.ts`).
- **Keep the fallback**: a guest runs the harness image pinned at deploy time,
  and on every other backend the two values are identical.
- Known debt: `AAI_REQUIRE_MICROSANDBOX` is declared in `turbo.json` but
  exported by nothing, so the real-microVM tier does not gate merges. A test
  that pins a value with one reader (`toBe(unrewritten)`) goes stale when a
  second reader appears.

## An envelope is only the codec's if the codec WROTE it

`typed-json.ts` tags binary as `{ __type: "Uint8Array", data }`, dates as
`{ __type: "Date", iso }`, and (storage codec only) `Map`/`Set`; revivers
recognise envelopes structurally. A run's `input` arrives over public HTTP, so
an author's look-alike object must never revive.

**The fix is round-trip TOTALITY**: `typed-json-escape.ts` renames an author's
reserved keys on encode (`__type` → `___type`, `___type` → `____type`) and back
on decode — injective, and nothing maps onto `__type`. Easy to undo by
accident:

- **A key rename, never a wrapper** — the reviver runs bottom-up and would
  revive the inner envelope first.
- **The pattern is `/^__+type$/`, the whole family.**
- **Rebuild with `Object.fromEntries`, never `out[key] = …`** — assignment hits
  the `__proto__` setter.
- Decode still accepts a bare `__type` envelope (existing rows), so deploy
  decoder-first.
- **A new envelope kind**: encode PAIRS and let the replacer recurse on both
  halves; refuse a malformed payload. The escape never reads the tag's value,
  so it needs no change. Known hole: no unsupported-type guard, so other exotic
  values journal as `{}` — the fix is a structural check at the step boundary.
- Strict decoding: base64 via `Uint8Array.fromBase64(…, { lastChunkHandling:
  "strict" })`; an unparsable `iso` throws (`iso: null` still revives an
  invalid `Date` — the encoder's own spelling). Callers classify the throw
  (`decodeBody` → 400; the guest fails the step).
- Only the storage RPC emits the date envelope; the queue path never does.

**`typed-json-property.test.ts` is the pattern for other codecs**: keys drawn
from a pool with the reserved family and `__proto__`, strings with `"Date"`,
`"Uint8Array"` and valid/invalid base64, plus `envelopeShape` constructing full
forged envelopes and a **coverage floor** so the property cannot pass
vacuously. Named cases stay as regression pins. A/B a mutation before trusting
a test — note `{ __proto__: … }` as a literal creates no own property.
