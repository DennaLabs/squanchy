#!/usr/bin/env bash
# squanchy installer — downloads a prebuilt binary from GitHub Releases into ~/.local/bin.
#
#   curl -fsSL https://raw.githubusercontent.com/crampeddamselfly/squanchy/main/install.sh | bash
#
# Options (env vars):
#   SQUANCHY_VERSION   install a specific version, e.g. v0.3.0 (default: latest)
#   INSTALL_DIR        install directory (default: $HOME/.local/bin)
#   GITHUB_TOKEN       needed while the repo is private (also honors GH_TOKEN)
set -euo pipefail

REPO="crampeddamselfly/squanchy"
VERSION="${SQUANCHY_VERSION:-latest}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"

say() { printf '%s\n' "$*" >&2; }
die() { say "squanchy install error: $*"; exit 1; }

# --- platform detection ---
kernel="$(uname -s)"
machine="$(uname -m)"
case "$kernel" in
  Linux*)  os="linux" ;;
  Darwin*) os="darwin" ;;
  MINGW*|MSYS*|CYGWIN*) os="windows" ;;
  *) die "unsupported platform: $kernel (build from source: see README)" ;;
esac
case "$machine" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) die "unsupported architecture: $machine" ;;
esac
asset="squanchy-${os}-${arch}"
[ "$os" = "windows" ] && asset="${asset}.exe"

# --- download ---
if [ "$VERSION" = "latest" ]; then
  url="https://github.com/$REPO/releases/latest/download/$asset"
else
  url="https://github.com/$REPO/releases/download/$VERSION/$asset"
fi

auth=()
[ -n "$TOKEN" ] && auth=(-H "Authorization: Bearer $TOKEN")

say "downloading $asset ($VERSION) ..."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if ! curl -fsSL "${auth[@]}" -o "$tmp/$asset" "$url"; then
  if [ -z "$TOKEN" ]; then
    die "download failed. If the repo is private, retry with: GITHUB_TOKEN=*** curl ... | bash"
  fi
  die "download failed: $url (check version/asset exists and token has repo access)"
fi

# --- install ---
mkdir -p "$INSTALL_DIR"
mv "$tmp/$asset" "$INSTALL_DIR/squanchy$([ "$os" = "windows" ] && echo .exe)"
chmod +x "$INSTALL_DIR/squanchy$([ "$os" = "windows" ] && echo .exe)"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    say ""
    say "NOTE: $INSTALL_DIR is not on your PATH. Add it with:"
    say "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc   # or ~/.bashrc"
    ;;
esac

say ""
say "squanchy installed to $INSTALL_DIR/squanchy"
say "start with:  squanchy init"
