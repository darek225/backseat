#!/usr/bin/env python3
"""muse-watch: lightweight bridge mirror for the Muse side of Backseat.

Polls the bridge repo with git (cheap: one fetch per cycle), keeps a private
mirror clone, and maintains two small files:

  state.json  - every task's queue (pending/active/done), state, progress
                note, heartbeat; rewritten only when something changed.
  events.log  - append-only transition log (task started / finished / ...),
                trimmed to the last 200 lines.

Muse reads state.json instead of running git itself. A cron that watches for
completion just reads one small file per wake.

The mirror is read-only from the watcher's perspective: it never commits, so
`git reset --hard` to the remote is always safe. Keep this AWAY from any
clone you commit/push task files with.

Usage:
    watch.py <repo-url> <workdir>
    env: MUSE_WATCH_POLL (seconds between polls, default 30)
"""
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

POLL_SECS = int(os.environ.get("MUSE_WATCH_POLL", "30"))
KEEP_EVENTS = 200


def sh(args, cwd):
    try:
        return subprocess.run(args, cwd=cwd, capture_output=True,
                              text=True, timeout=60)
    except Exception as e:  # noqa: BLE001 - fail soft, never kill the loop
        return None


def utcnow():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(workdir, msg):
    with open(os.path.join(workdir, "watch.log"), "a") as f:
        f.write(f"{utcnow()} {msg}\n")


def default_branch(gitdir):
    r = sh(["git", "symbolic-ref", "refs/remotes/origin/HEAD"], cwd=gitdir)
    if r and r.returncode == 0:
        ref = r.stdout.strip()  # refs/remotes/origin/main
        return ref.split("/")[-1]
    return "main"


def sync(gitdir, workdir):
    """Fetch and hard-reset the mirror to the remote. Returns (rev, branch)."""
    r = sh(["git", "fetch", "-q", "origin"], cwd=gitdir)
    if not r or r.returncode != 0:
        raise RuntimeError("fetch failed")
    branch = default_branch(gitdir)
    remote_ref = f"refs/remotes/origin/{branch}"
    r = sh(["git", "rev-parse", "HEAD", remote_ref], cwd=gitdir)
    if not r or r.returncode != 0:
        raise RuntimeError("rev-parse failed")
    local_rev, remote_rev = r.stdout.split()
    if local_rev != remote_rev:
        r = sh(["git", "reset", "-q", "--hard", remote_ref], cwd=gitdir)
        if not r or r.returncode != 0:
            raise RuntimeError("reset failed")
    return remote_rev[:12], branch


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:  # noqa: BLE001 - corrupt/unreadable file, skip it
        return {}


def scan(gitdir):
    """Build {task_id: {...}} from tasks/pending|active|done|status."""
    tasks = {}

    def tid(fn):
        return fn[:-5] if fn.endswith(".json") else fn

    def ensure(t):
        return tasks.setdefault(t, {"queue": None, "state": None,
                                    "progress_note": None, "heartbeat_at": None,
                                    "finished_at": None, "result": None,
                                    "late_watch": None, "completed_late": None,
                                    "checkpoint_branch": None})

    for queue in ("pending", "active", "done"):
        d = os.path.join(gitdir, "tasks", queue)
        if not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            if not fn.endswith(".json"):
                continue
            t = ensure(tid(fn))
            t["queue"] = queue
            if queue == "pending" and not t["state"]:
                t["state"] = "pending"
            if queue == "done":
                data = read_json(os.path.join(d, fn))
                t["state"] = data.get("result")
                t["result"] = data.get("result")
                t["finished_at"] = data.get("finished_at")
                # 0.9.14 timeout-as-state fields, so the architect can see
                # late completions and checkpoint branches without git.
                t["late_watch"] = data.get("timeout_pending_late") or None
                t["completed_late"] = data.get("completed_late") or None
                cp = data.get("checkpoint") or {}
                t["checkpoint_branch"] = cp.get("branch") or None
                note = data.get("summary") or data.get("note") or data.get("error")
                if note:
                    t["progress_note"] = str(note)[:300]
    sd = os.path.join(gitdir, "tasks", "status")
    if os.path.isdir(sd):
        for fn in sorted(os.listdir(sd)):
            if not fn.endswith(".json"):
                continue
            t = ensure(tid(fn))
            data = read_json(os.path.join(sd, fn))
            if t.get("queue") != "done" and data.get("state"):
                # a stale status file must never override the done record
                t["state"] = data["state"]
            for k in ("progress_note", "heartbeat_at", "updated_at"):
                if data.get(k) and not t.get(k):
                    t[k] = data[k]
            # surface timeout-as-state flags from live status records too
            if data.get("late_watch") and not t.get("late_watch"):
                t["late_watch"] = True
            if data.get("completed_late") and not t.get("completed_late"):
                t["completed_late"] = True
            cp = data.get("checkpoint") or {}
            if cp.get("branch") and not t.get("checkpoint_branch"):
                t["checkpoint_branch"] = cp["branch"]
            if not t["queue"]:
                t["queue"] = "active" if data.get("state") not in (
                    "success", "timeout", "failed", "error", "cancelled") else "done"
    return tasks


def digest_of(tasks):
    return hashlib.sha1(json.dumps(tasks, sort_keys=True).encode()).hexdigest()


def transitions(old, new):
    """Human-readable lines for what changed between scans."""
    lines = []
    for tid_, t in sorted(new.items()):
        o = old.get(tid_)
        if o is None:
            lines.append(f"{tid_}: new ({t['queue']}/{t['state']})")
        elif o.get("queue") != t.get("queue") or o.get("state") != t.get("state"):
            lines.append(f"{tid_}: {o.get('queue')}/{o.get('state')} -> "
                         f"{t.get('queue')}/{t.get('state')}")
    for tid_ in sorted(set(old) - set(new)):
        lines.append(f"{tid_}: gone")
    return lines


def write_atomic(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(text)
    os.replace(tmp, path)


def tick(gitdir, workdir, repo_url, prev):
    """One poll cycle. Returns (changed, rev, branch, tasks)."""
    rev, branch = sync(gitdir, workdir)
    tasks = scan(gitdir)
    dgst = digest_of(tasks)
    changed = dgst != prev.get("digest")
    if changed:
        for line in transitions(prev.get("tasks", {}), tasks):
            with open(os.path.join(workdir, "events.log"), "a") as f:
                f.write(f"{utcnow()} {line}\n")
        # trim events.log
        ep = os.path.join(workdir, "events.log")
        if os.path.exists(ep):
            with open(ep) as f:
                lines = f.readlines()
            if len(lines) > KEEP_EVENTS:
                with open(ep, "w") as f:
                    f.writelines(lines[-KEEP_EVENTS:])
    return changed, dgst, tasks, rev, branch


def write_state(workdir, repo_url, rev, branch, tasks, health):
    """state.json is rewritten EVERY cycle (0.9.14): the health envelope
    is the staleness signal — a file whose last_ok_at stops moving means
    the daemon died, even when no task changed. healthcheck.sh reads it."""
    state = {"updated_at": utcnow(), "repo": repo_url, "rev": rev,
             "branch": branch, "poll_interval_sec": POLL_SECS,
             "expected_interval_sec": POLL_SECS * 3,
             "health": health, "tasks": tasks}
    write_atomic(os.path.join(workdir, "state.json"),
                 json.dumps(state, indent=1))


def main():
    repo_url = (sys.argv[1] if len(sys.argv) > 1
                else os.environ.get("MUSE_WATCH_REPO"))
    workdir = (sys.argv[2] if len(sys.argv) > 2
               else os.environ.get("MUSE_WATCH_DIR"))
    if not repo_url or not workdir:
        print("usage: watch.py <repo-url> <workdir>", file=sys.stderr)
        sys.exit(2)
    os.makedirs(workdir, exist_ok=True)
    gitdir = os.path.join(workdir, "mirror")
    if not os.path.isdir(os.path.join(gitdir, ".git")):
        r = sh(["git", "clone", "-q", repo_url, gitdir], cwd=workdir)
        if not r or r.returncode != 0:
            print("clone failed", file=sys.stderr)
            sys.exit(1)
        log(workdir, "cloned mirror")
    log(workdir, f"watcher started (poll {POLL_SECS}s)")
    prev_digest = None
    prev_tasks = {}
    rev, branch = "", ""
    health = {"status": "ok", "last_ok_at": None,
              "consecutive_failures": 0, "last_error": None}
    while True:
        try:
            changed, dgst, tasks, rev, branch = tick(
                gitdir, workdir, repo_url,
                {"digest": prev_digest, "tasks": prev_tasks})
            prev_digest, prev_tasks = dgst, tasks
            health = {"status": "ok", "last_ok_at": utcnow(),
                      "consecutive_failures": 0, "last_error": None}
            write_state(workdir, repo_url, rev, branch, tasks, health)
        except Exception as e:  # noqa: BLE001 - fail soft, retry next cycle
            health["consecutive_failures"] += 1
            health["last_error"] = str(e)[:300]
            health["status"] = "stale" if health["consecutive_failures"] >= 5 else "degraded"
            log(workdir, f"tick error: {e}")
            try:
                # Keep the last known tasks: a failing poll must not wipe
                # the view, and the health envelope still moves so a dead
                # daemon (no writes at all) is distinguishable from a
                # struggling one.
                write_state(workdir, repo_url, rev, branch, prev_tasks, health)
            except Exception:
                pass  # even the state write failed; next cycle retries
        time.sleep(POLL_SECS)


if __name__ == "__main__":
    main()
