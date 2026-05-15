#!/usr/bin/env bash
# Claude Terminal Sidebar — installer
#
# 1. Installs server deps via npm.
# 2. Templates the wrapper script + native-messaging manifest with this
#    machine's absolute node path and this checkout's directory.
# 3. Installs the manifest into the right Chrome (and Chromium-family) dirs.
#
# Re-run anytime — every step is idempotent.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$REPO_DIR/server"
HOST_NAME="com.cts.bridge"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
warn() { printf "\033[33m%s\033[0m\n" "$*" >&2; }
fail() { printf "\033[31m%s\033[0m\n" "$*" >&2; exit 1; }

# ----- 1. checks -----
command -v node >/dev/null || fail "node not found in PATH. Install Node 18+ (nvm, brew install node, etc.) and retry."
command -v npm  >/dev/null || fail "npm not found in PATH."

NODE_BIN="$(command -v node)"
# Resolve symlinks (e.g. /opt/homebrew/bin/node -> /opt/homebrew/Cellar/...).
# We want a path that won't break if the user's PATH ever shrinks (which is
# what happens when Chrome spawns the native host).
NODE_BIN="$(readlink -f "$NODE_BIN" 2>/dev/null || python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$NODE_BIN")"
bold "Using node at: $NODE_BIN"

# ----- 2. npm install -----
bold "Installing server deps…"
( cd "$SERVER_DIR" && npm install --silent )

# Spawn-helper executable bit can be stripped by npm tarball (known
# node-pty bug). Belt-and-suspenders chmod.
chmod +x "$SERVER_DIR"/node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true
chmod +x "$SERVER_DIR/native-host.js"

# ----- 3. template the wrapper -----
WRAPPER="$SERVER_DIR/cts-native-host.sh"
sed \
  -e "s|__NODE__|$NODE_BIN|g" \
  -e "s|__NATIVE_HOST_JS__|$SERVER_DIR/native-host.js|g" \
  "$SERVER_DIR/cts-native-host.sh.tmpl" > "$WRAPPER"
chmod +x "$WRAPPER"
bold "Wrote wrapper: $WRAPPER"

# ----- 4. ask for the extension ID -----
cat <<EOF

Now load the extension in Chrome (skip if already loaded):
  1. Open chrome://extensions
  2. Enable "Developer mode" (top right)
  3. Click "Load unpacked" and select:
       $REPO_DIR/extension
  4. The extension card now shows an ID like "abcd…xyz" — copy it.

EOF
read -r -p "Paste the extension ID: " EXT_ID
EXT_ID="$(echo "$EXT_ID" | tr -d '[:space:]')"
[[ "$EXT_ID" =~ ^[a-p]{32}$ ]] || fail "That doesn't look like a valid Chrome extension ID (32 lowercase a-p chars)."

# ----- 5. write & install the manifest into every Chromium-family dir we find -----
TMP_MANIFEST="$(mktemp)"
sed \
  -e "s|__WRAPPER__|$WRAPPER|g" \
  -e "s|__EXTENSION_ID__|$EXT_ID|g" \
  "$SERVER_DIR/native-host-manifest.json.tmpl" > "$TMP_MANIFEST"

case "$OSTYPE" in
  darwin*)
    DIRS=(
      "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
      "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts"
      "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
      "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
      "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      "$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts"
    ) ;;
  linux*)
    DIRS=(
      "$HOME/.config/google-chrome/NativeMessagingHosts"
      "$HOME/.config/chromium/NativeMessagingHosts"
      "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    ) ;;
  *)
    fail "Unsupported OS: $OSTYPE (the bridge needs paths under your Chrome user-data dir)" ;;
esac

INSTALLED=0
for d in "${DIRS[@]}"; do
  parent="$(dirname "$d")"
  if [[ -d "$parent" ]]; then
    mkdir -p "$d"
    cp "$TMP_MANIFEST" "$d/${HOST_NAME}.json"
    bold "Installed manifest -> $d/${HOST_NAME}.json"
    INSTALLED=$((INSTALLED+1))
  fi
done
rm -f "$TMP_MANIFEST"
[[ $INSTALLED -gt 0 ]] || warn "Didn't find any Chromium-family browser dirs. Install Chrome and re-run."

cat <<EOF

$(bold "Done.")
Click the extension's toolbar icon to open the side panel. The shell starts
when the panel opens and dies when it closes.

If the panel says "Specified native messaging host not found":
  - The extension ID changed — re-run this script with the new ID.

To uninstall the bridge:
  rm "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/${HOST_NAME}.json"
  (and the equivalent path for any other Chromium-family browser)

EOF
