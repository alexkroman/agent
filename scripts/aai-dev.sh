#!/usr/bin/env bash
# Run aai CLI from monorepo source — no build step needed.
# Usage: alias aai-dev="/path/to/agent/scripts/aai-dev.sh"

MONOREPO="$(cd "$(dirname "$0")/.." && pwd)"

exec "${MONOREPO}/node_modules/.bin/tsx" --conditions=@dev/source "${MONOREPO}/packages/aai-cli/cli.ts" "$@"
