#!/bin/bash
# healthcheck.sh — is the muse-watch daemon alive and polling?
#
# Usage: healthcheck.sh <watchdir> [max-age-secs]
#
# Exit 0 when healthy (prints OK / WARNING for degraded). Exit 1 with a
# reason when the watcher is stale or its state is unreadable.
#
# WHY: a silently dead watcher is indistinguishable from a quiet bridge
# (BACKSEAT_BUGS_2026-10-12, bug 4). state.json now carries a health
# envelope whose last_ok_at moves every poll cycle — when it stops
# moving, the daemon died. Wire this into a systemd timer (see
# systemd/ for examples) or any other scheduler.
set -u
DIR="${1:-}"
MAX_AGE="${2:-}"
fail() { echo "UNHEALTHY: $1"; exit 1; }
[ -n "$DIR" ] || { echo "usage: healthcheck.sh <watchdir> [max-age-secs]" >&2; exit 2; }
STATE="$DIR/state.json"
[ -d "$DIR" ] || fail "watchdir $DIR does not exist"
[ -f "$STATE" ] || fail "no state.json in $DIR (watcher never wrote state)"
python3 - "$STATE" "$MAX_AGE" << 'PYEOF'
import json, sys
from datetime import datetime, timezone
path, max_age = sys.argv[1], sys.argv[2]
try:
    st = json.load(open(path))
except Exception as e:
    print(f"UNHEALTHY: state.json unreadable: {e}")
    sys.exit(1)
health = st.get("health") or {}
last_ok = health.get("last_ok_at")
status = health.get("status", "?")
if not last_ok:
    print(f"UNHEALTHY: watcher never completed a poll (status={status}, "
          f"failures={health.get('consecutive_failures')}, last_error={health.get('last_error')})")
    sys.exit(1)
try:
    dt = datetime.fromisoformat(str(last_ok).replace("Z", "+00:00"))
    age = (datetime.now(timezone.utc) - dt).total_seconds()
except Exception as e:
    print(f"UNHEALTHY: bad last_ok_at {last_ok!r}: {e}")
    sys.exit(1)
limit = float(max_age) if max_age else float(st.get("expected_interval_sec") or 180)
if age > limit:
    print(f"UNHEALTHY: last successful poll {int(age)}s ago "
          f"(limit {int(limit)}s, status={status}, last_error={health.get('last_error')})")
    sys.exit(1)
if status == "stale":
    print(f"UNHEALTHY: watcher reports stale: {health.get('last_error')}")
    sys.exit(1)
if status == "degraded":
    # Transient (e.g. a few failed fetches) — visible in logs, but not
    # worth waking anyone: it self-recovers on the next good poll.
    print(f"WARNING: watcher degraded ({health.get('consecutive_failures')} "
          f"consecutive failures): {health.get('last_error')}")
    sys.exit(0)
print(f"OK: last poll {int(age)}s ago, status={status}")
PYEOF
