#!/bin/sh
# Retention sweep for ~/.local/state/choros/. Deletes .json files older than 30 days from
# every instance's inbox/read/ and sent/ directories. Live inbox/ is untouched.
#
# Install as a nightly cron:
#   echo "30 3 * * *  $HOME/.claude/msg-channel/retain.sh >> $HOME/.claude/msg-channel/retain.log 2>&1" | crontab -
#
# Or run manually any time.

set -eu

TTL_DAYS="${MSG_RETAIN_DAYS:-30}"
ROOT="$HOME/.claude/msg"

[ -d "$ROOT" ] || exit 0

ts() { date -Iseconds; }

deleted_read=0
deleted_sent=0
deleted_seen=0

for d in "$ROOT"/*/; do
  [ -d "$d" ] || continue
  inst=$(basename "$d")

  if [ -d "${d}inbox/read" ]; then
    n=$(find "${d}inbox/read" -maxdepth 1 -name '*.json' -type f -mtime "+$TTL_DAYS" 2>/dev/null | wc -l)
    if [ "$n" -gt 0 ]; then
      find "${d}inbox/read" -maxdepth 1 -name '*.json' -type f -mtime "+$TTL_DAYS" -delete 2>/dev/null || true
      deleted_read=$((deleted_read + n))
      printf '%s  swept %d files from %sinbox/read/\n' "$(ts)" "$n" "$d"
    fi
  fi

  if [ -d "${d}sent" ]; then
    n=$(find "${d}sent" -maxdepth 1 -name '*.json' -type f -mtime "+$TTL_DAYS" 2>/dev/null | wc -l)
    if [ "$n" -gt 0 ]; then
      find "${d}sent" -maxdepth 1 -name '*.json' -type f -mtime "+$TTL_DAYS" -delete 2>/dev/null || true
      deleted_sent=$((deleted_sent + n))
      printf '%s  swept %d files from %ssent/\n' "$(ts)" "$n" "$d"
    fi
  fi

  # Orphaned .seen sidecars whose .json is gone (defensive — link-claim normally cleans these)
  if [ -d "${d}inbox" ]; then
    find "${d}inbox" -maxdepth 1 -name '*.json.seen' -type f 2>/dev/null | while read -r seen; do
      json="${seen%.seen}"
      [ ! -e "$json" ] && rm -f "$seen" && deleted_seen=$((deleted_seen + 1)) || true
    done
  fi
done

printf '%s  retention done: read=%d sent=%d seen-orphans=%d (TTL %d days)\n' \
  "$(ts)" "$deleted_read" "$deleted_sent" "$deleted_seen" "$TTL_DAYS"
