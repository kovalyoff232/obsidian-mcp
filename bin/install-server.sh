#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")"/.. && pwd)"
DIST="$ROOT_DIR/dist"

echo "Installing MCP server..."
mkdir -p "$DIST"

# Placeholder: in a real pipeline we would download from Releases by tag/OS
if [[ ! -f "$DIST/mcp_server.js" ]]; then
  echo "mcp_server.js not found in dist/. Build first (npm run build:mcp)." >&2
  exit 1
fi

echo "Calculating checksum:"
sha256sum "$DIST/mcp_server.js" | tee "$DIST/mcp_server.js.sha256"

echo "Done."


