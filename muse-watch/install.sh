#!/bin/bash
# muse-watch installer / control script (Linux).
#
#   install.sh <repo>      install + start watching a bridge repo
#                          <repo> = owner/repo slug or full git URL
#   install.sh status      show daemon status + state freshness
#   install.sh stop        stop all watchers
#
# Layout: ~/.backseat/muse-watch/<owner-repo>/
#           watch.py, mirror/ (git mirror, read-only), state.json,
#           events.log, watch.log, watch.pid
set -u
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE="$HOME/.backseat/muse-watch"

slugify() { echo "$1" | sed 's#https\?://##; s#\.git$##; s#[^A-Za-z0-9._-]#-#g'; }
repo_url() {
  case "$1" in
    http*|*@*:*) echo "$1" ;;
    */*) echo "https://github.com/$1.git" ;;
    *) echo "https://github.com/$1.git" ;;
  esac
}
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

cmd="${1:-}"
case "$cmd" in
  status)
    found=0
    for d in "$BASE"/*/; do
      [ -d "$d" ] || continue
      found=1
      pid="$(cat "$d/watch.pid" 2>/dev/null || true)"
      if alive "$pid"; then st="running (pid $pid)"; else st="STOPPED"; fi
      fresh="$(python3 -c "import json;print(json.load(open('$d/state.json'))['updated_at'])" 2>/dev/null || echo "no state yet")"
      echo "$(basename "$d"): $st, state updated $fresh"
    done
    [ "$found" = 0 ] && echo "no watchers installed"
    ;;
  stop)
    for pidfile in "$BASE"/*/watch.pid; do
      [ -f "$pidfile" ] || continue
      pid="$(cat "$pidfile")"
      if alive "$pid"; then kill "$pid" && echo "stopped $pid"; fi
      rm -f "$pidfile"
    done
    echo "all watchers stopped"
    ;;
  "")
    echo "usage: install.sh <owner/repo|git-url> | status | stop" >&2; exit 2 ;;
  *)
    url="$(repo_url "$cmd")"
    slug="$(slugify "$cmd")"
    dir="$BASE/$slug"
    mkdir -p "$dir"
    cp "$SRC_DIR/watch.py" "$dir/watch.py"
    chmod +x "$dir/watch.py"
    oldpid="$(cat "$dir/watch.pid" 2>/dev/null || true)"
    if alive "$oldpid"; then echo "already running (pid $oldpid) in $dir"; exit 0; fi
    cd "$dir"
    nohup python3 watch.py "$url" "$dir" >> watch.log 2>&1 &
    echo $! > watch.pid
    sleep 8
    if alive "$(cat watch.pid)"; then
      echo "watcher started for $url"
      echo "state: $dir/state.json"
    else
      echo "FAILED to start - see $dir/watch.log"; tail -5 watch.log; exit 1
    fi
    ;;
esac
