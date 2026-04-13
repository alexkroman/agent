#!/usr/bin/env bash
set -euo pipefail

# Non-interactive changeset creation for agents and CI.
# Usage:
#   scripts/create-changeset.sh --pkg @alexkroman1/aai --bump patch --summary "Fix bug"
#   scripts/create-changeset.sh --pkg @alexkroman1/aai --pkg @alexkroman1/aai-ui --bump minor --summary "Add feature"
#   scripts/create-changeset.sh --empty

PACKAGES=()
BUMP=""
SUMMARY=""
EMPTY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pkg)
      if [[ -z "${2:-}" || "$2" == --* ]]; then
        echo "Error: --pkg requires a value." >&2
        exit 1
      fi
      PACKAGES+=("$2")
      shift 2
      ;;
    --bump)
      if [[ -z "${2:-}" || "$2" == --* ]]; then
        echo "Error: --bump requires a value." >&2
        exit 1
      fi
      BUMP="$2"
      shift 2
      ;;
    --summary)
      if [[ -z "${2:-}" || "$2" == --* ]]; then
        echo "Error: --summary requires a value." >&2
        exit 1
      fi
      SUMMARY="$2"
      shift 2
      ;;
    --empty)
      EMPTY=true
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 --pkg <package> --bump <patch|minor|major> --summary <text>" >&2
      echo "       $0 --empty --summary <text>" >&2
      exit 1
      ;;
  esac
done

if [ "$EMPTY" = true ]; then
  # Use changeset's built-in empty command
  pnpm changeset add --empty
  echo "Created empty changeset."
  exit 0
fi

# Validate required args
if [ ${#PACKAGES[@]} -eq 0 ]; then
  echo "Error: At least one --pkg is required (or use --empty)." >&2
  exit 1
fi

if [ -z "$BUMP" ]; then
  echo "Error: --bump is required (patch, minor, or major)." >&2
  exit 1
fi

if [[ ! "$BUMP" =~ ^(patch|minor|major)$ ]]; then
  echo "Error: --bump must be patch, minor, or major. Got: $BUMP" >&2
  exit 1
fi

if [ -z "$SUMMARY" ]; then
  echo "Error: --summary is required." >&2
  exit 1
fi

# Generate a random filename (mimics changeset CLI style)
WORDS=("brave" "calm" "cool" "cyan" "dark" "deep" "fair" "fast" "free" "gold"
       "gray" "keen" "kind" "lean" "loud" "mild" "neat" "nice" "pale" "pink"
       "pure" "rare" "real" "rich" "safe" "slim" "soft" "tall" "thin" "warm"
       "wide" "wild" "wise" "bold" "cold")
NOUNS=("ants" "bats" "bees" "cats" "cows" "deer" "dogs" "dove" "duck" "eels"
       "fish" "frog" "goat" "hawk" "hens" "lamb" "lion" "mice" "moth" "mule"
       "newt" "owls" "pigs" "rats" "seal" "slug" "swan" "toad" "vole" "wasp"
       "wolf" "worm" "yaks" "crow" "bear")
VERBS=("ask" "bid" "bow" "cry" "dig" "eat" "fly" "hum" "jog" "mix"
       "nap" "nod" "pop" "run" "sew" "sit" "tap" "try" "win" "yawn")

FILENAME=""
for _attempt in 1 2 3 4 5; do
  w1=${WORDS[$((RANDOM % ${#WORDS[@]}))]}
  w2=${NOUNS[$((RANDOM % ${#NOUNS[@]}))]}
  w3=${VERBS[$((RANDOM % ${#VERBS[@]}))]}
  candidate=".changeset/${w1}-${w2}-${w3}.md"
  if [ ! -e "$candidate" ]; then
    FILENAME="$candidate"
    break
  fi
done
if [ -z "$FILENAME" ]; then
  echo "Error: Could not generate a unique changeset filename after 5 attempts." >&2
  exit 1
fi

# Build the YAML front matter
{
  echo "---"
  for pkg in "${PACKAGES[@]}"; do
    echo "\"${pkg}\": ${BUMP}"
  done
  echo "---"
  echo ""
  echo "$SUMMARY"
} > "$FILENAME"

echo "Created changeset: $FILENAME"
