#!/bin/bash
# Provision Node 24 for Claude Code on the web sessions.
#
# The repo requires Node >=24 <27 (package.json engines), but the default
# sandbox image ships Node 22. Under Node 22 the unit suite fails on
# Node >=23 globals (e.g. CloseEvent in ws-handler-pacing.test.ts), which
# also blocks the lefthook pre-push `pnpm check`.
set -euo pipefail

# Local machines manage their own Node — only run in the remote sandbox.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

export NVM_DIR="${NVM_DIR:-/opt/nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "session-start: nvm not found at $NVM_DIR; keeping the image's default Node" >&2
  exit 0
fi

# nvm reads unset variables internally; relax nounset around it.
set +u
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install 24 --no-progress
nvm alias default 24 >/dev/null
NODE24_BIN="$(dirname "$(nvm which 24)")"
set -u

# pnpm for the Node 24 install, at the version package.json pins.
PNPM_VERSION="$("$NODE24_BIN/node" -e 'process.stdout.write((require("./package.json").packageManager || "").split("@")[1] || "")' 2>/dev/null || true)"
if [ ! -x "$NODE24_BIN/pnpm" ]; then
  "$NODE24_BIN/npm" install -g "pnpm@${PNPM_VERSION:-latest}" >/dev/null
fi

# Put Node 24 first on PATH for the rest of the session.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export NVM_DIR=\"$NVM_DIR\""
    echo "export PATH=\"$NODE24_BIN:\$PATH\""
  } >>"$CLAUDE_ENV_FILE"
fi

echo "session-start: Node $("$NODE24_BIN/node" --version) + pnpm $("$NODE24_BIN/pnpm" --version) provisioned"
