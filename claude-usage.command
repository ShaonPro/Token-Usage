#!/usr/bin/env bash
# Claude Usage Dashboard — macOS launcher.
# Double-click this file in Finder to start the dashboard.

set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Claude Usage Dashboard"
  echo "  ----------------------"
  echo "  Node.js is not installed."
  echo "  Get it from https://nodejs.org (you need version 22.5 or newer),"
  echo "  then double-click this file again."
  echo
  read -n 1 -s -r -p "  Press any key to close..."
  echo
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.').map(Number)[0]" 2>/dev/null || echo 0)
NODE_MINOR=$(node -p "process.versions.node.split('.').map(Number)[1]" 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  echo
  echo "  Claude Usage Dashboard needs Node.js 22.5 or newer."
  echo "  You have: $(node -v)"
  echo "  Update from https://nodejs.org"
  echo
  read -n 1 -s -r -p "  Press any key to close..."
  echo
  exit 1
fi

exec node server.js
