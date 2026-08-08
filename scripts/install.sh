#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE_COMMAND=${NODE_COMMAND:-node}

if ! command -v "$NODE_COMMAND" >/dev/null 2>&1; then
  cat >&2 <<'EOF'
Node.js was not found.

Required: Node.js 20 or newer.
Install an LTS release from https://nodejs.org/, then rerun:
  ./scripts/install.sh --check

Common package managers:
  macOS:   brew install node@22
  Windows: winget install OpenJS.NodeJS.LTS
  Linux:   use your distribution package manager or the Node.js download page
EOF
  exit 2
fi

NODE_MAJOR=$($NODE_COMMAND -p "Number(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then
  printf 'Node.js %s is unsupported; install Node.js 20 or newer.\n' "$($NODE_COMMAND --version)" >&2
  exit 2
fi

exec "$NODE_COMMAND" "$SCRIPT_DIR/install.mjs" "$@"
