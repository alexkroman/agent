#!/bin/bash
# Provision the repo's Node major for Claude Code on the web sessions.
#
# The repo requires Node >=24 <27 (package.json engines) and pins its own
# major in .node-version, but the default sandbox image ships Node 22. Under
# Node 22 the unit suite fails on Node >=23 globals (e.g. CloseEvent in
# ws-handler-pacing.test.ts), which also blocks the lefthook pre-push
# `pnpm check`.
#
# The version is READ from .node-version rather than hardcoded here: this
# script mentions the major in half a dozen places, and a sandbox provisioning
# a different Node than CI and the Modal images is exactly the drift that is
# invisible until a version-specific failure shows up in one environment only.
set -euo pipefail

# Local machines manage their own Node — only run in the remote sandbox.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

NODE_MAJOR="$(tr -d '[:space:]' <.node-version 2>/dev/null || true)"
if [ -z "$NODE_MAJOR" ]; then
  echo "session-start: could not read .node-version; keeping the image's default Node" >&2
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
nvm install "$NODE_MAJOR" --no-progress
nvm alias default "$NODE_MAJOR" >/dev/null
NODE_BIN="$(dirname "$(nvm which "$NODE_MAJOR")")"
set -u

# pnpm for that Node install, at the version package.json pins.
PNPM_VERSION="$("$NODE_BIN/node" -e 'process.stdout.write((require("./package.json").packageManager || "").split("@")[1] || "")' 2>/dev/null || true)"
if [ ! -x "$NODE_BIN/pnpm" ]; then
  "$NODE_BIN/npm" install -g "pnpm@${PNPM_VERSION:-latest}" >/dev/null
fi

# Put it first on PATH for the rest of the session.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export NVM_DIR=\"$NVM_DIR\""
    echo "export PATH=\"$NODE_BIN:\$PATH\""
  } >>"$CLAUDE_ENV_FILE"
fi

echo "session-start: Node $("$NODE_BIN/node" --version) + pnpm $("$NODE_BIN/pnpm" --version) provisioned"
