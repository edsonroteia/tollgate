#!/bin/bash
# Wrapper script for Tollgate native messaging host.
# Chrome launches this script, which runs the Node.js host.

DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/native-host.mjs"
