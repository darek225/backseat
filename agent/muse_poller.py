#!/usr/bin/env python3
"""
Muse-side poller for the Muse <-> Cline GitHub bridge.

Designed to run on a cron schedule (every few minutes). It:
  1. git pulls the bridge repo,
  2. scans tasks/pending, tasks/active, tasks/done, tasks/status,
  3. diffs against a local state file,
  4. prints a compact human-readable summary of what's new/changed.

Muse reads this output and reports to Darek in chat. The poller itself
sends nothing -- it only prints.

Stdlib only. Usage:
    python muse_poller.py --repo ~/bridge-repo [--state ~/.muse-cline-bridge-state.json]
"""

import argparse
import json
import os
import subprocess
import sys


def sh(cmd, cwd, timeout=120):
    try:
        p = subprocess.run(
            cmd, cwd=cwd, timeout=timeout,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
        )
        return p.returncode, p.stdout
    except Exception as e:  # noqa: BLE001
        return 1, str(e)


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def snapshot(repo):
    """Read all task + status files into a dict keyed by task id."""
    snap = {}
    for sub in ("pending", "active", "done"):
        d = os.path.join(repo, "tasks", sub)
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            if not f.endswith(".json"):
                continue
            task = read_json(os.path.join(d, f))
            if not task:
                continue
            tid = task.get("id") or f[:-5]
            snap[tid] = {
                "queue": sub,
                "title": task.get("title") or tid,
                "result": task.get("result"),
                "error": (task.get("error") or "")[:300] if task.get("error") else None,
                "created_at": task.get("created_at"),
                "finished_at": task.get("finished_at"),
            }
    # Overlay live status.
    d = os.path.join(repo, "tasks", "status")
    if os.path.isdir(d):
        for f in sorted(os.listdir(d)):
            if not f.endswith(".json"):
                continue
            st = read_json(os.path.join(d, f))
            if not st:
                continue
            tid = st.get("id") or f[:-5]
            entry = snap.setdefault(tid, {"queue": "?", "title": tid})
            entry["state"] = st.get("state")
            entry["updated_at"] = st.get("updated_at")
            entry["heartbeat_at"] = st.get("heartbeat_at")
            entry["progress_note"] = st.get("progress_note")
            entry["log_tail"] = (st.get("log_tail") or "")[-1500:]
    return snap


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="local clone of the bridge repo")
    ap.add_argument("--state", default=os.path.expanduser("~/.muse-cline-bridge-state.json"))
    args = ap.parse_args()

    repo = os.path.abspath(os.path.expanduser(args.repo))
    if not os.path.isdir(os.path.join(repo, ".git")):
        print(f"ERROR: not a git repo: {repo}")
        sys.exit(2)

    rc, out = sh(["git", "pull", "--ff-only"], cwd=repo)
    if rc != 0:
        print(f"WARNING: git pull failed, using local copy:\n{out[-500:]}")

    prev = read_json(args.state) or {}
    cur = snapshot(repo)

    new_tasks, updates, done = [], [], []

    for tid, info in cur.items():
        old = prev.get(tid)
        if old is None:
            # Brand-new task id seen.
            if info["queue"] == "done":
                done.append((tid, info))
            else:
                new_tasks.append((tid, info))
        else:
            # Existing: report queue moves, state changes, new completions.
            if info["queue"] != old.get("queue"):
                if info["queue"] == "done":
                    done.append((tid, info))
                else:
                    updates.append((tid, info, f"moved {old.get('queue')} -> {info['queue']}"))
            elif info.get("state") != old.get("state"):
                updates.append((tid, info, f"state {old.get('state')} -> {info.get('state')}"))
            elif info["queue"] == "done" and not old.get("result"):
                done.append((tid, info))

    # Stalled detection: running but no heartbeat for >120s.
    import datetime
    now = datetime.datetime.now(datetime.timezone.utc)
    stalled = []
    for tid, info in cur.items():
        if info.get("queue") == "active" and info.get("state") == "running":
            hb = info.get("heartbeat_at")
            try:
                hb_t = datetime.datetime.strptime(hb, "%Y-%m-%dT%H:%M:%SZ").replace(
                    tzinfo=datetime.timezone.utc)
                if (now - hb_t).total_seconds() > 120:
                    stalled.append((tid, info))
            except (TypeError, ValueError):
                pass

    if not new_tasks and not updates and not done and not stalled:
        print("No changes since last poll.")
    else:
        for tid, info in new_tasks:
            print(f"NEW [{info['queue']}] {tid}: {info['title']}")
        for tid, info, what in updates:
            note = f" -- {info['progress_note']}" if info.get("progress_note") else ""
            print(f"UPDATE {tid}: {what}{note}")
            if info.get("log_tail"):
                print("  log tail:")
                for line in info["log_tail"].splitlines()[-8:]:
                    print(f"    {line}")
        for tid, info in done:
            print(f"DONE {tid}: {info['title']} -> {info.get('result')}")
            if info.get("error"):
                print(f"  error: {info['error']}")
        for tid, info in stalled:
            print(f"STALLED {tid}: {info['title']} (no heartbeat >120s, watcher may be down)")

    # Queue overview (always useful context).
    counts = {"pending": 0, "active": 0, "done": 0}
    for info in cur.values():
        if info["queue"] in counts:
            counts[info["queue"]] += 1
    print(f"\nQueues: {counts['pending']} pending, {counts['active']} active, {counts['done']} done.")

    # Save state for next run.
    try:
        tmp = args.state + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cur, f, indent=2)
        os.replace(tmp, args.state)
    except OSError as e:
        print(f"WARNING: could not save state file: {e}")


if __name__ == "__main__":
    main()
