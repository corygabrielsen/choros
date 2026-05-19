#!/usr/bin/env bash
# choros daemon uninstaller. Leaves $XDG_STATE_HOME/choros/ in place
# (state survives uninstall by design — re-install reads the existing
# database).
set -euo pipefail

PLATFORM="$(uname -s)"

case "$PLATFORM" in
  Linux)
    UNIT_DEST="$HOME/.config/systemd/user/choros.service"
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user disable --now choros 2>/dev/null || true
    fi
    rm -f "$UNIT_DEST"
    echo "[choros] removed unit: $UNIT_DEST"
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user daemon-reload || true
    fi
    ;;
  Darwin)
    PLIST_DEST="$HOME/Library/LaunchAgents/com.choros.daemon.plist"
    if command -v launchctl >/dev/null 2>&1; then
      launchctl bootout "gui/$UID/com.choros.daemon" 2>/dev/null || true
    fi
    rm -f "$PLIST_DEST"
    echo "[choros] removed agent: $PLIST_DEST"
    ;;
  *)
    echo "[choros] unsupported platform: $PLATFORM" >&2
    exit 1
    ;;
esac

echo "[choros] uninstall complete. State at \$XDG_STATE_HOME/choros/ preserved."
echo "[choros] to wipe state: rm -rf \"\${XDG_STATE_HOME:-\$HOME/.local/state}/choros\""
