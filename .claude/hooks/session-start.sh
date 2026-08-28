#!/bin/bash
# Provision the repo's Node major for Claude Code on the web sessions.
#
# The repo requires Node >=26 <27 (package.json engines) and pins its own
# major in .node-version, but the default sandbox image ships Node 22. Under
# Node 22 the unit suite fails on newer globals — `AsyncDisposableStack` in
# aai-studio-server's `studio-session-ensure.ts` (25 tests), `CloseEvent` in
# `ws-handler-pacing.test.ts` — which also blocks the lefthook pre-push
# `pnpm check`, so a whole session's work cannot be pushed through the hook.
#
# The version is READ from .node-version rather than hardcoded here: this
# script mentions the major in half a dozen places, and a sandbox provisioning
# a different Node than CI and the Modal images is exactly the drift that is
# invisible until a version-specific failure shows up in one environment only.
#
# ## A green Node does NOT make root `pnpm test` green in a small sandbox
#
# Worth knowing before blaming a change for it, and it is a SEPARATE cause from
# the version. `turbo run test` fans all sixteen packages out at once, and two
# aai-cli specs run real Vite builds — `_build.test.ts`'s
# "ships a working __aaiCreateRuntime factory" and `workflow-bundler.test.ts`'s
# "exports the flow code and the step code, and not the manifest". Under that
# parallelism they exceed their timeouts (120s and 5s) on a constrained runner,
# while `pnpm vitest run --project aai-cli` passes all 572. Measured on Node
# v26.8.1: root run red on exactly those two, every package green on its own.
# So verify per package here, and do not "fix" it by raising those timeouts.
#
# ## Do NOT add `set -e` to this script
#
# It had one, and that is why it never provisioned anything. **nvm is not
# errexit-safe**: its version resolution probes several sources and reads a
# nonzero exit as "not that one", so under `set -e` the probe chain aborts and
# `nvm_ls_remote` yields an EMPTY list. `nvm install 26` then resolves to `N/A`
# and returns 3. Isolated by A/B on this image, with v26.8.1 reachable
# throughout:
#
#   set -e            → nvm version-remote 26 → (empty)
#   set -o pipefail   → nvm version-remote 26 → v26.8.1
#   set -u            → nvm version-remote 26 → v26.8.1
#
# So `-e` alone breaks it; `pipefail` and `-u` are fine and are kept. Worse,
# `-e` also killed the script at that `return 3` — before every `echo` below —
# so the failure was SILENT: the session started on Node 22, said nothing about
# it, and the first symptom was 25 unrelated-looking test failures much later.
# Errors are checked explicitly here instead, and a failure to provision is
# ANNOUNCED. That is the same rule the ratchets in AGENTS.md follow: a step that
# reports success while doing nothing is worse than one that fails.

set -uo pipefail

say() { echo "session-start: $*"; }
warn() { echo "session-start: $*" >&2; }

# What a future session needs to know if it ends up here anyway. Loud, and it
# names the symptom rather than only the cause, because the symptom is what
# somebody will be looking at.
report_stale_node() {
  warn ""
  warn "WARNING: running on Node $(node --version 2>/dev/null || echo unknown), but this repo needs v${NODE_MAJOR}."
  warn "  Reason: $1"
  warn "  Expect \`pnpm test\` at the repo root to be RED for reasons unrelated to your"
  warn "  change — aai-studio-server (>=26) uses AsyncDisposableStack, which the"
  warn "  image's Node 22 does not define (25 tests) — and the lefthook pre-push"
  warn "  \`pnpm check\` to fail with it."
  warn "  Verify per package instead (pnpm vitest run --project <name>), and say so when"
  warn "  reporting results. To retry provisioning by hand:"
  warn "    export NVM_DIR=/opt/nvm && . \$NVM_DIR/nvm.sh && nvm install ${NODE_MAJOR}"
  warn "  (in a shell with no \`set -e\`, per this script's header)."
  warn ""
}

# Local machines manage their own Node — only run in the remote sandbox.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

NODE_MAJOR="$(tr -d '[:space:]' <.node-version 2>/dev/null || true)"
if [ -z "$NODE_MAJOR" ]; then
  warn "could not read .node-version; keeping the image's default Node $(node --version 2>/dev/null)"
  exit 0
fi

export NVM_DIR="${NVM_DIR:-/opt/nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  report_stale_node "nvm not found at $NVM_DIR"
  exit 0
fi

# nvm reads unset variables internally, and must not run under errexit — see
# the header. `pipefail` stays on; it is not implicated.
set +u
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"

if ! nvm install "$NODE_MAJOR" --no-progress; then
  set -u
  report_stale_node "nvm install $NODE_MAJOR failed (no matching version, or the mirror is unreachable)"
  exit 0
fi
nvm alias default "$NODE_MAJOR" >/dev/null 2>&1
NODE_BIN="$(dirname "$(nvm which "$NODE_MAJOR" 2>/dev/null)" 2>/dev/null)"
set -u

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN/node" ]; then
  report_stale_node "nvm reported no usable binary for $NODE_MAJOR"
  exit 0
fi

# pnpm for that Node install, at the version package.json pins.
PNPM_VERSION="$("$NODE_BIN/node" -e 'process.stdout.write((require("./package.json").packageManager || "").split("@")[1] || "")' 2>/dev/null || true)"
if [ ! -x "$NODE_BIN/pnpm" ]; then
  if ! "$NODE_BIN/npm" install -g "pnpm@${PNPM_VERSION:-latest}" >/dev/null 2>&1; then
    warn "could not install pnpm@${PNPM_VERSION:-latest} for Node $NODE_MAJOR; the image's pnpm stays on PATH"
  fi
fi

# Put it first on PATH for the rest of the session. Without this the install
# above is inert — every later tool call still resolves the image's Node — so a
# missing CLAUDE_ENV_FILE is a real failure and not a cosmetic one.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export NVM_DIR=\"$NVM_DIR\""
    echo "export PATH=\"$NODE_BIN:\$PATH\""
  } >>"$CLAUDE_ENV_FILE"
else
  report_stale_node "CLAUDE_ENV_FILE is unset, so the provisioned Node cannot be put on PATH"
  exit 0
fi

say "Node $("$NODE_BIN/node" --version) + pnpm $("$NODE_BIN/pnpm" --version 2>/dev/null || echo '(image)') provisioned"
