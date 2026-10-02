---
summary: >-
  Self-hosting: `aai start` and the built worker, `aai build --target`'s
  per-host emits (Vercel, Deno, Modal), the deploy-env warning, and the
  Node/Deno/Bun certification of the serve half
read_when: >-
  changing `aai start`, `createProjectServer`, a `--target` emit, or anything
  the self-hosted output must run on
---

# packages/aai-cli — self-hosting and build targets

Reference sibling of `packages/aai-cli/CLAUDE.md`. Paths are under
`packages/aai-cli/src/` unless they name a package.

## Self-hosting is the DEFAULT, and `aai build --target` emits per host

**`aai start` is the self-hosting command** (`start.ts`; the module doc has the
precedent). The scaffold's `prestart`/`start` (`aai build --skip-tests`, then
`aai start`) makes every `init`/`pull` project run with `npm start`. The boot is
a command, not a scaffolded file, so improvements reach existing projects. The
custom-server opt-out is `createProjectServer` on `@alexkroman1/aai-cli/start` —
builds the `AgentServer`, binds nothing (also what a serverless host wants).

**`--target` is Nitro's preset shape** (`_build-target.ts`): an entry file is
EMITTED into build output, never committed. Per-host modules:
`_vercel-target.ts`, `_deno-target.ts`, `_modal-target.ts`; `_target-entry.ts`
(shared long-lived entry), `_target-drain.ts` (signal handler),
`_target-output.ts` (self-contained directory assembly for deno + modal). The
dependency runs one way: `_build-target.ts` reads each host module, never the
reverse — a new target is a new file plus two lines.

- **Detection reads the host's build env**: Vercel via `VERCEL`, `VERCEL_ENV` or
  `NOW_BUILDER` (all three); Deno via `DENO_DEPLOY` or `DENO_DEPLOYMENT_ID`
  (both platform generations). It cannot fire for a locally built upload
  (`deno deploy`, `modal deploy`), which passes the flag. Otherwise `node`
  (emits nothing extra).
- **Every target names the command that ships it, as DATA** (`TARGET_OUTPUTS`, a
  total record over `BuildTarget`), printed and on the result (`log` is silent
  under `--json`).
- **A host build WARNS about a declared variable the host has no value for**
  (`missingDeployEnv` in `build.ts`, `missingEnv` on the result,
  `TargetOutput.secret` for the fix command). It reads **the host environment
  only, never `resolveServerEnv`** — `.env` is uploaded into a host's build
  workspace (Vercel ignores `.gitignore`) but not shipped (`RUNTIME_FILES` in
  `_vercel-output.ts`; shipping it would leak credentials). Declarations come
  from `DEPLOY_ENV_DECLARATION_FILE` alone. It warns rather than gates (a build
  cannot see runtime-only host vars); `node` is exempt.
- **Vercel routing brackets `handle: filesystem` with two `/assets/` rules**
  (Vite's content-hashed dir): before it,
  `cache-control: public, max-age=31536000, immutable` with `continue: true`;
  after it, a terminal 404 with `no-store` (a miss there is a stale
  `index.html`, and would otherwise inherit the immutable header). Everything
  else falls through.
- **Vercel's Node major rounds UP** (`vercelNodeRuntime`: smallest offered major
  ≥ the build's, clamped at newest).
- **`--target deno` emits a self-contained `.aai/deno/`** (bundled server,
  worker, client, `.env.example`, no install step — Deno Deploy dies caching the
  CLI's toolchain graph otherwise), plus a `.aai/deno/deno.json` with a `start`
  task (`-A`; makes the directory runnable by hand).
- **Long-lived entries drain on `SIGINT`/`SIGTERM`** via one shared
  `TARGET_DRAIN_SOURCE`; registration is wrapped in `try` because a host without
  signals throws from `Deno.addSignalListener`.
- **`_deno-output.scenario.test.ts` checks the module GRAPH** with
  `deno info --json` and reads the modules (not the exit code, which is 0 on
  unresolved deps) — boot-and-serve cannot see a dangling edge in a comment.
  Gated by `describeWithBinary` (`_test-utils.ts`); **`AAI_REQUIRE_DENO`** makes
  the skip a failure (set by CI after `deno --version` answers, declared in
  `check:scenario`'s `env`). Deno is pinned EXACT (2.9.5). Booting the emit is
  `_target-runtimes.scenario.test.ts`'s (below).
- **`--target modal` emits `.aai/modal/` plus a generated `.aai/modal/app.py`**
  (`_modal-app.ts`; deploy with `modal deploy .aai/modal/app.py`). Load-bearing
  in it: `@modal.concurrent` (otherwise one WebSocket blocks every other caller
  and asset); `_run_node` forwards the stop signal to node (see `run_node` in
  `scripts/modal_image.py`); `PORT` comes from one constant into both the image
  env and `@modal.web_server(port=…)`.
- **Modal policy is deploy-time env, not edits to `.aai/modal/app.py`**:
  `AAI_MODAL_APP`, `AAI_MODAL_SECRET`, `AAI_MODAL_MIN_CONTAINERS`,
  `AAI_MODAL_MAX_CONTAINERS`; `_modal-app.test.ts` checks advertised knobs ==
  read knobs both ways. cpu/memory/timeout/concurrency stay visible constants.
- **Modal has NO auto-detection, deliberately**: `MODAL_IS_REMOTE`/
  `MODAL_TASK_ID` are set inside containers — including this platform's own
  guest sandboxes where studio Publish runs the CLI — and `MODAL_TOKEN_ID` says
  nothing about intent. `_build-target.test.ts` requires every target to be
  selectable by flag.
- **`_modal-output.scenario.test.ts` is the only reader of the generated
  Python**: `python3 -m py_compile`, and an import where the client is
  installed. **`AAI_REQUIRE_MODAL`** makes the skip a failure (a local escape
  hatch — no CI job installs the client). Its boot arm needs no gate: it proves
  no-`node_modules`, `process.env.PORT` and SIGTERM-closes on plain node.

## Self-hosted output must run on Node, Deno and Bun

- **Only the SERVE half is portable** — `createProjectServer` + `listen` + the
  drain over a directory with no `node_modules`. `aai build` is Node; never try
  to certify it elsewhere, and keep anything runtime-specific out of the entry.
- **One entry for every host** (`_target-entry.ts`): `RUNTIME_PORT_SOURCE` reads
  the port under any runtime; `_target-entry.test.ts` pins the real entries to
  one body modulo a banner and a default port.
- **`_target-runtimes.scenario.test.ts` is the certification**: one memoized
  emit, booted under `node`, `deno` and `bun`, each asserting boot without
  `node_modules`, `/health` + `/client-config` + `/`, a `/websocket` dial (to
  `session.configured`, no key spent), and exit 0 on SIGTERM.
- **The bundle's `node:` imports are pinned** to `PORTABLE_NODE_BUILTINS`
  (`_target-bundle.ts`); `FEATURE_DETECTED_NODE_BUILTINS` (`node:sqlite`) must
  never be a static import.
- **Bun floor is 1.4.0** (below it undici crashes on import and a bundled `ws`
  upgrade writes zero bytes). `minVersion` on the bun arm, CI pins 1.4.2, and
  `runtime-pins-gate.test.ts` fails if the pin drops below the floor. A binary
  below the floor counts as absent (skip; failure under `AAI_REQUIRE_BUN`). **Do
  not restore an undici patch for older Bun**; restate the floor. A "works
  outside a bundle, not inside" Bun report: Bun substitutes native `ws` only
  when imported by name.
- **There is deliberately no `--target bun`**: Bun is a runtime, not a host, and
  every target owes a verified non-empty deploy sequence
  (`_build-target.test.ts`).

## Self-hosting is the scaffold's default, and it runs the BUILT worker

**`aai start` imports `.aai/worker.mjs`, which `prestart`
(`aai build --skip-tests`) produces.** Tools are registered by the bundler
enumerating `tools/`, so an un-bundled loader would serve an agent with no tools
and no error. That is why `aai build` leaves its worker on disk and why the
scaffold declares `prestart` (`scaffold/package.json` is the single definition).

- **There is no runtime `tools/` scan anywhere**, by decision — one way to build
  a registry. Specs use `import.meta.glob` (see
  `packages/aai-templates/src/_discovery.ts`).
- **No `registerHooks` shim**: Vite inlines `?raw` and attribute-less `.json`
  imports. The worker import is dynamic via `pathToFileURL` (Windows-correct).
- **A missing artifact exits with the command that fixes it**, never boots a
  tool-less agent or throws a bare `ERR_MODULE_NOT_FOUND`.
- **`ctx.env` and provider credentials come from different places.** `env` is
  declared keys only (`.env`, plus `.env.example` as declarations; real env vars
  win per key), as under `aai dev`. Provider credentials go through
  `withHostCredentialFallback` (so `docker run -e ASSEMBLYAI_API_KEY=…` works
  without entering `ctx.env`). An empty declared value is DROPPED.
- The CLI is a devDependency of self-hosting, so `npm ci --omit=dev` is not
  supported; `prestart` skips only tests.
- `e2e.test.ts` boots `npm start` on an installed `pizza-ordering-agent` (chosen
  for its `tools/`), probes `/health`, `/client-config`, `/`, and reads the six
  tool names out of the booted artifact.
