#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")"/.. && pwd)"
DIST="$ROOT_DIR/dist"

echo "Installing MCP server..."
mkdir -p "$DIST"

TAG="${1:-latest}"
REPO="${GITHUB_REPOSITORY:-kovalyoff/obsidian-mcp-plugin}"

if [[ "$TAG" == "latest" ]]; then
  API_URL="https://api.github.com/repos/$REPO/releases/latest"
else
  API_URL="https://api.github.com/repos/$REPO/releases/tags/$TAG"
fi

TMP_DIR="$(mktemp -d)"
echo "Fetching release metadata: $API_URL"
curl -sSL "$API_URL" > "$TMP_DIR/release.json"

ASSET_JS_URL=$(jq -r '.assets[] | select(.name=="mcp_server.js") | .browser_download_url' "$TMP_DIR/release.json")
ASSET_SUM_URL=$(jq -r '.assets[] | select(.name=="SHA256SUMS.txt") | .browser_download_url' "$TMP_DIR/release.json")

if [[ -z "$ASSET_JS_URL" || -z "$ASSET_SUM_URL" ]]; then
  echo "Release assets not found. Fallback to local dist/." >&2
else
  echo "Downloading artifacts..."
  curl -sSL "$ASSET_JS_URL" -o "$DIST/mcp_server.js"
  curl -sSL "$ASSET_SUM_URL" -o "$DIST/SHA256SUMS.txt"
fi

if [[ ! -f "$DIST/mcp_server.js" ]]; then
  echo "mcp_server.js not found. Build first (npm run build:mcp)." >&2
  exit 1
fi

echo "Verifying checksum..."
cd "$DIST"
if command -v sha256sum >/dev/null 2>&1; then
  if [[ -f SHA256SUMS.txt ]]; then
    grep " mcp_server.js$" SHA256SUMS.txt | sha256sum -c - || {
      echo "Checksum verification failed!" >&2; exit 2; }
  else
    sha256sum mcp_server.js | tee mcp_server.js.sha256
  fi
else
  shasum -a 256 mcp_server.js | tee mcp_server.js.sha256
fi

echo "Done."


