#!/bin/sh
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/bin/cah.js" uninstall "$@"
exec node "$SCRIPT_DIR/bin/cah.js" install "$@"
