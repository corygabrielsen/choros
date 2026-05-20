#!/usr/bin/env bash
# choros installer — per-user, no sudo.
#
# Installs the daemon as a service (systemd --user on Linux, launchd on
# macOS) AND registers the MCP shim with Claude Code. Idempotent.
#
# Why both: the daemon backs every shim, and the shim is the per-CC MCP
# server. Installing only the daemon leaves the shim half unwired — the
# exact failure mode where a hand-pasted MCP entry points at a stale
# path. This script owns the registration so it can't drift.
set -euo pipefail

CHOROS_ROOT="${CHOROS_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
PLATFORM="$(uname -s)"

# --- Preflight: bun must be resolvable, or the service exits 127 in a
#     crashloop with a cryptic journal line. Fail loud, here, instead. ---
if ! command -v bun >/dev/null 2>&1; then
  echo "[choros] bun not found on PATH. Install bun first: https://bun.sh" >&2
  exit 1
fi
BUN_BIN="$(command -v bun)"
BUN_DIR="$(dirname "$BUN_BIN")"
echo "[choros] using bun at $BUN_BIN"

register_mcp() {
  # Register (or re-register) the shim as a user-scope MCP server so
  # the path is always correct. Remove-then-add makes it idempotent and
  # self-healing against a stale entry.
  if command -v claude >/dev/null 2>&1; then
    claude mcp remove --scope user choros >/dev/null 2>&1 || true
    claude mcp add --scope user choros -- bun run "$CHOROS_ROOT/src/shim/main.ts"
    echo "[choros] registered MCP shim (user scope) → $CHOROS_ROOT/src/shim/main.ts"
  else
    echo "[choros] 'claude' CLI not found — register the MCP shim manually:" >&2
    echo "         claude mcp add --scope user choros -- bun run $CHOROS_ROOT/src/shim/main.ts" >&2
  fi
}

case "$PLATFORM" in
  Linux)
    UNIT_SRC="$CHOROS_ROOT/install/choros.service"
    UNIT_DEST="$HOME/.config/systemd/user/choros.service"
    DROPIN_DIR="$HOME/.config/systemd/user/choros.service.d"
    mkdir -p "$(dirname "$UNIT_DEST")" "$DROPIN_DIR"
    if [ -L "$UNIT_DEST" ] || [ -f "$UNIT_DEST" ]; then
      rm -f "$UNIT_DEST"
    fi
    ln -s "$UNIT_SRC" "$UNIT_DEST"
    echo "[choros] installed unit: $UNIT_DEST"
    # systemd --user runs with a minimal PATH (/usr/bin:/bin) that lacks
    # ~/.local/bin (and ~/.bun/bin), so `/usr/bin/env bun` exits 127.
    # A drop-in pins PATH to include bun's actual directory. Generated
    # here (not committed) because bun's location is host-specific.
    cat > "$DROPIN_DIR/override.conf" <<EOF
[Service]
Environment=PATH=$BUN_DIR:/usr/local/bin:/usr/bin:/bin
EOF
    echo "[choros] wrote PATH drop-in: $DROPIN_DIR/override.conf"
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user daemon-reload
      systemctl --user enable --now choros
      echo "[choros] daemon started via systemd --user"
      echo "[choros] follow logs: journalctl --user -u choros -f"
    else
      echo "[choros] systemctl not found — start manually: bun run $CHOROS_ROOT/src/daemon/main.ts"
    fi
    ;;
  Darwin)
    PLIST_SRC="$CHOROS_ROOT/install/com.choros.daemon.plist"
    PLIST_DEST="$HOME/Library/LaunchAgents/com.choros.daemon.plist"
    LOG_DIR="$HOME/Library/Logs/choros"
    mkdir -p "$(dirname "$PLIST_DEST")" "$LOG_DIR"
    # launchd plists can't expand $HOME or inherit the login PATH —
    # substitute both the home dir and bun's directory at install time.
    sed -e "s|HOME_PLACEHOLDER|$HOME|g" -e "s|BUN_DIR_PLACEHOLDER|$BUN_DIR|g" \
      "$PLIST_SRC" > "$PLIST_DEST"
    echo "[choros] installed agent: $PLIST_DEST"
    if command -v launchctl >/dev/null 2>&1; then
      launchctl bootout "gui/$UID/com.choros.daemon" 2>/dev/null || true
      launchctl bootstrap "gui/$UID" "$PLIST_DEST"
      launchctl enable "gui/$UID/com.choros.daemon"
      launchctl kickstart -k "gui/$UID/com.choros.daemon"
      echo "[choros] daemon started via launchd"
      echo "[choros] logs: $LOG_DIR/daemon.{out,err}.log"
    else
      echo "[choros] launchctl not found — odd, you should investigate"
    fi
    ;;
  *)
    echo "[choros] unsupported platform: $PLATFORM" >&2
    echo "[choros] supported: Linux (systemd --user), Darwin (launchd LaunchAgent)" >&2
    exit 1
    ;;
esac

register_mcp

echo "[choros] done. Restart Claude Code (or Reconnect the choros MCP) to pick up the shim."
