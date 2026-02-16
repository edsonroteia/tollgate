#!/bin/bash
# Wrapper script for Tollgate native messaging host.
# Chrome launches this script, which runs the Node.js host.
# Chrome doesn't load shell profiles, so we need to find node ourselves.

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/native-host.mjs"
