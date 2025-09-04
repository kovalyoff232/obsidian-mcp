#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")"/.. && pwd)"
DIST="$ROOT_DIR/dist"

print_usage() {
  cat <<'EOF'
Usage: bin/install-server.sh [--tag vX.Y.Z|latest] [--repo owner/repo] [--help]
Purpose: Update dist/mcp_server.js in the current plugin folder from GitHub Releases.
Notes: Not a plugin installer; your plugin must already live under .obsidian/plugins/.

Examples:
  bin/install-server.sh                      # latest from detected repo
  bin/install-server.sh --tag v1.2.3         # specific tag from detected repo
  bin/install-server.sh --repo owner/repo    # override repo (owner/repo)
  bin/install-server.sh --repo owner/repo --tag v1.2.3

Env:
  GITHUB_REPOSITORY  Fallback for --repo (format: owner/repo)
EOF
}

# Defaults
TAG="latest"
REPO="${GITHUB_REPOSITORY:-}"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      print_usage
      exit 0
      ;;
    --tag)
      TAG="${2:-latest}"
      shift 2
      ;;
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    *)
      # Backward-compat: positional first arg as tag
      TAG="$1"
      shift
      ;;
  esac
done

# Detect repo from git if not provided
detect_repo() {
  local url owner repo
  url="$(git -C "$ROOT_DIR" config --get remote.origin.url 2>/dev/null || true)"
  if [[ -n "$url" ]]; then
    if [[ "$url" =~ ^https?://github.com/([^/]+)/([^/]+)(\.git)?$ ]]; then
      owner="${BASH_REMATCH[1]}"; repo="${BASH_REMATCH[2]}"
      echo "${owner}/${repo%.git}"
      return
    elif [[ "$url" =~ ^git@github.com:([^/]+)/([^/]+)(\.git)?$ ]]; then
      owner="${BASH_REMATCH[1]}"; repo="${BASH_REMATCH[2]}"
      echo "${owner}/${repo%.git}"
      return
    fi
  fi
  echo ""
}

if [[ -z "$REPO" ]]; then
  REPO="$(detect_repo || true)"
fi
if [[ -z "$REPO" ]]; then
  echo "Repository not specified and could not detect from git. Use --repo owner/repo or set GITHUB_REPOSITORY." >&2
  print_usage
  exit 1
fi

echo "Installing MCP server artifact into: $DIST"
mkdir -p "$DIST"

if [[ "$TAG" == "latest" ]]; then
  API_URL="https://api.github.com/repos/$REPO/releases/latest"
else
  API_URL="https://api.github.com/repos/$REPO/releases/tags/$TAG"
fi

echo "Fetching release metadata: $API_URL"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is not installed. Skipping remote download; will use local dist if present." >&2
else
  curl -sSL "$API_URL" > "$TMP_DIR/release.json"
  ASSET_JS_URL="$(jq -r '.assets[] | select(.name=="mcp_server.js") | .browser_download_url' "$TMP_DIR/release.json")"
  ASSET_SUM_URL="$(jq -r '.assets[] | select(.name=="SHA256SUMS.txt") | .browser_download_url' "$TMP_DIR/release.json")"

  if [[ -n "$ASSET_JS_URL" && -n "$ASSET_SUM_URL" ]]; then
    echo "Downloading artifacts..."
    curl -sSL "$ASSET_JS_URL" -o "$DIST/mcp_server.js"
    curl -sSL "$ASSET_SUM_URL" -o "$DIST/SHA256SUMS.txt"
  else
    echo "Release assets not found. Falling back to local dist/." >&2
  fi
fi

if [[ ! -f "$DIST/mcp_server.js" ]]; then
  echo "mcp_server.js not found in dist/. Build first (npm run build) or fetch a release (--repo/--tag)." >&2
  exit 1
fi

echo "Verifying checksum..."
cd "$DIST"
if command -v sha256sum >/dev/null 2>&1; then
  if [[ -f SHA256SUMS.txt ]]; then
    grep " mcp_server.js$" SHA256SUMS.txt | sha256sum -c - || { echo "Checksum verification failed!" >&2; exit 2; }
  else
    sha256sum mcp_server.js | tee mcp_server.js.sha256
  fi
else
  shasum -a 256 mcp_server.js | tee mcp_server.js.sha256
fi

echo "Done."
