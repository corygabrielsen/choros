#!/usr/bin/env bash
# Migration: ~/.claude/msg-channel + ~/.claude/msg/  →  ~/code/choros + $XDG_STATE_HOME/choros
#
# Run this AFTER fully exiting Claude Code.
# If a bun msg-channel is still running this aborts.

set -euo pipefail

if pgrep -af "msg-channel/server\.ts" >/dev/null 2>&1; then
  echo "ERROR: a bun msg-channel server is still running. Exit Claude Code first."
  pgrep -af "msg-channel/server\.ts"
  exit 1
fi

CLAUDE_CFG="$HOME/.claude.json"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/choros"
CHOROS_HOME="$HOME/code/choros"

if [ ! -f "$CHOROS_HOME/src/main.ts" ]; then
  echo "ERROR: $CHOROS_HOME/src/main.ts not found — staging missing."
  exit 1
fi

# 1. Backup .claude.json
ts=$(date +%s)
cp "$CLAUDE_CFG" "$CLAUDE_CFG.bak.$ts"
echo "backup: $CLAUDE_CFG.bak.$ts"

# 2. Rewrite MCP registration: add choros, remove msg
tmp=$(mktemp)
jq --arg path "$CHOROS_HOME/src/main.ts" '
  .mcpServers.choros = {
    type: "stdio",
    command: "bun",
    args: [$path],
    env: {}
  }
  | del(.mcpServers.msg)
' "$CLAUDE_CFG" > "$tmp"
mv "$tmp" "$CLAUDE_CFG"
echo "MCP registration: msg → choros (path: $CHOROS_HOME/src/main.ts)"

# 3. Symlink skill into Claude's skill dir
mkdir -p "$HOME/.claude/skills"
ln -sfn "$CHOROS_HOME/skill" "$HOME/.claude/skills/choros"
echo "skill: ~/.claude/skills/choros → $CHOROS_HOME/skill"

# 4. Remove old skill dir
rm -rf "$HOME/.claude/skills/msg"
echo "removed: ~/.claude/skills/msg"

# 5. Wipe old data dir under ~/.claude (Anthropic's namespace)
rm -rf "$HOME/.claude/msg"
echo "removed: ~/.claude/msg"

# 6. Create new XDG state dir
mkdir -p "$STATE_DIR"
echo "state dir: $STATE_DIR"

# 7. Old server tree stays at ~/.claude/msg-channel for one cycle.
#    Delete manually after confirming the new bun starts cleanly:
#      rm -rf ~/.claude/msg-channel

echo ""
echo "Done. Start a new Claude Code session."
echo "On boot: bun spawns from $CHOROS_HOME/src/main.ts; state lands in $STATE_DIR."
echo "Verify:  pgrep -af 'choros/src/main.ts'"
