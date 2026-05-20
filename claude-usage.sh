#!/usr/bin/env bash
# Claude Usage Dashboard — Linux / macOS terminal launcher.
# Run: ./claude-usage.sh

set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js is not installed. Get it from https://nodejs.org (>=22.5)."
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.').map(Number)[0]" 2>/dev/null || echo 0)
NODE_MINOR=$(node -p "process.versions.node.split('.').map(Number)[1]" 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  echo "  Need Node.js 22.5+ (you have $(node -v)). Update from https://nodejs.org"
  exit 1
fi

exec node server.js
