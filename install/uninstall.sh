#!/usr/bin/env bash
# choros uninstaller. Leaves the state dir in place (state survives
# uninstall by design — re-install reads the existing database).
set -euo pipefail

PLATFORM="$(uname -s)"

# Drop the MCP registration so a half-uninstall doesn't leave Claude
# Code pointing at a daemon that's no longer running.
if command -v claude >/dev/null 2>&1; then
  claude mcp remove --scope user choros >/dev/null 2>&1 || true
  echo "[choros] removed MCP shim registration (user scope)"
fi

case "$PLATFORM" in
  Linux)
    UNIT_DEST="$HOME/.config/systemd/user/choros.service"
    DROPIN_DIR="$HOME/.config/systemd/user/choros.service.d"
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user disable --now choros 2>/dev/null || true
    fi
    rm -f "$UNIT_DEST"
    rm -rf "$DROPIN_DIR"
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
