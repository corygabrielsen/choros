#!/usr/bin/env bash
# choros daemon installer — per-user, no sudo.
#
# Detects Linux (systemd) vs macOS (launchd) and installs the
# appropriate unit/agent. Idempotent.
set -euo pipefail

CHOROS_ROOT="${CHOROS_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
PLATFORM="$(uname -s)"

case "$PLATFORM" in
  Linux)
    UNIT_SRC="$CHOROS_ROOT/install/choros.service"
    UNIT_DEST="$HOME/.config/systemd/user/choros.service"
    mkdir -p "$(dirname "$UNIT_DEST")"
    if [ -L "$UNIT_DEST" ] || [ -f "$UNIT_DEST" ]; then
      rm -f "$UNIT_DEST"
    fi
    ln -s "$UNIT_SRC" "$UNIT_DEST"
    echo "[choros] installed unit: $UNIT_DEST"
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user daemon-reload
      systemctl --user enable --now choros
      echo "[choros] daemon started via systemd --user"
      echo "[choros] follow logs: journalctl --user -u choros -f"
    else
      echo "[choros] systemctl not found — start manually: bun run \$CHOROS_ROOT/src/daemon/main.ts"
    fi
    ;;
  Darwin)
    PLIST_SRC="$CHOROS_ROOT/install/com.choros.daemon.plist"
    PLIST_DEST="$HOME/Library/LaunchAgents/com.choros.daemon.plist"
    LOG_DIR="$HOME/Library/Logs/choros"
    mkdir -p "$(dirname "$PLIST_DEST")" "$LOG_DIR"
    # launchd plists can't expand $HOME — substitute at install time.
    sed "s|HOME_PLACEHOLDER|$HOME|g" "$PLIST_SRC" > "$PLIST_DEST"
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

echo "[choros] verify with: bun run \$CHOROS_ROOT/src/daemon/main.ts --version  (or restart Claude Code)"
