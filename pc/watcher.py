#!/usr/bin/env python3
"""
Muse <-> Cline bridge: PC-side watcher (Windows).

Polls the bridge GitHub repo for pending tasks, claims them, runs
`cline --yolo "<prompt>"` headlessly, and pushes status + results back.

Stdlib only. Requires: Python 3.10+, Git on PATH, Cline CLI installed
and authenticated (your DeepSeek key stays in Cline's local config --
this script never sees it, sends it, or writes it anywhere).

Usage:
    python watcher.py [--config pc\\config.json] [--once]

Config (see config.example.json):
    repo_dir      local clone of the bridge repo
    poll_interval_sec  how often to check for work (default 20)
    cline_cmd     command to invoke cline (default "cline"; use full path if needed)
    default_timeout_sec  kill cline after this long (default 1800)
    heartbeat_sec how often to push status while running (default 30)
"""

import argparse
import datetime
import json
import os
import subprocess
import sys
import time
import traceback

TASKS_DIR = "tasks"
PENDING = os.path.join(TASKS_DIR, "pending")
ACTIVE = os.path.join(TASKS_DIR, "active")
DONE = os.path.join(TASKS_DIR, "done")
STATUS = os.path.join(TASKS_DIR, "status")

LOG_TAIL_LINES = 40
LOG_TAIL_BYTES = 8192


def utcnow():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg, logfile):
    line = f"[{utcnow()}] {msg}"
    print(line, flush=True)
    try:
        with open(logfile, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def run(cmd, cwd, timeout=None, logfile=None):
    """Run a command, return (returncode, stdout+stderr text)."""
    try:
        proc = subprocess.run(
            cmd,
            cwd=cwd,
            timeout=timeout,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        return proc.returncode, proc.stdout
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or "") if isinstance(e.stdout, str) else ""
        return None, out + "\n[TIMEOUT]"
    except FileNotFoundError as e:
        if logfile:
            log(f"Command not found: {cmd[0]}: {e}", logfile)
        return None, f"Command not found: {cmd[0]}"
    except Exception as e:  # noqa: BLE001 - keep the watcher alive
        if logfile:
            log(f"Command error: {e}", logfile)
        return None, f"Command error: {e}"


def git(cfg, logfile, *args, timeout=120):
    """Run git in the repo dir. Returns (rc, output)."""
    return run(["git", *args], cwd=cfg["repo_dir"], timeout=timeout, logfile=logfile)


def read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2)
    os.replace(tmp, path)  # atomic on Windows and POSIX


def sync_repo(cfg, logfile):
    """Pull latest. Returns True on success."""
    rc, out = git(cfg, logfile, "pull", "--ff-only")
    if rc != 0:
        log(f"git pull failed (rc={rc}): {out[-500:]}", logfile)
        return False
    return True


def push(cfg, logfile, message):
    """Commit all changes and push. Returns True if push succeeded."""
    rc, out = git(cfg, logfile, "add", "-A")
    if rc != 0:
        log(f"git add failed: {out[-300:]}", logfile)
        return False
    rc, out = git(cfg, logfile, "diff", "--cached", "--quiet")
    if rc == 0:
        return True  # nothing to commit, treat as success
    rc, out = git(cfg, logfile, "commit", "-m", message)
    if rc != 0:
        log(f"git commit failed: {out[-300:]}", logfile)
        return False
    rc, out = git(cfg, logfile, "push")
    if rc != 0:
        log(f"git push failed (will retry next loop): {out[-500:]}", logfile)
        return False
    return True


def list_pending(cfg):
    d = os.path.join(cfg["repo_dir"], PENDING)
    if not os.path.isdir(d):
        return []
    return sorted(
        f for f in os.listdir(d) if f.endswith(".json") and os.path.isfile(os.path.join(d, f))
    )


def write_status(cfg, task_id, state, log_tail="", progress_note=""):
    status = {
        "id": task_id,
        "state": state,
        "updated_at": utcnow(),
        "heartbeat_at": utcnow(),
        "log_tail": log_tail[-LOG_TAIL_BYTES:],
        "progress_note": progress_note,
    }
    write_json(os.path.join(cfg["repo_dir"], STATUS, f"{task_id}.json"), status)


def tail_lines(text, n=LOG_TAIL_LINES):
    lines = text.splitlines()
    return "\n".join(lines[-n:])


def claim_task(cfg, logfile, filename):
    """
    Claim the oldest pending task. Returns the task dict, or None if
    nothing to do / claim lost to another watcher.
    """
    repo = cfg["repo_dir"]
    src = os.path.join(repo, PENDING, filename)
    dst = os.path.join(repo, ACTIVE, filename)
    try:
        task = read_json(src)
    except (OSError, json.JSONDecodeError) as e:
        log(f"Skipping unreadable task {filename}: {e}", logfile)
        return None
    task_id = task.get("id") or filename[:-5]

    os.makedirs(os.path.dirname(dst), exist_ok=True)
    os.replace(src, dst)  # local claim

    # The push is the distributed lock: first pusher wins.
    if not push(cfg, logfile, f"claim task {task_id}"):
        # Push rejected (or failed) -- someone else may have claimed it.
        # Re-sync and check whether the task is still ours.
        sync_repo(cfg, logfile)
        if not os.path.exists(dst) and not os.path.exists(
            os.path.join(repo, PENDING, filename)
        ):
            log(f"Claim lost for {task_id} (taken by another watcher)", logfile)
            return None
        # Push failed for another reason (network etc.) -- keep the local
        # claim and retry the push; do NOT run the task twice.
        if not push(cfg, logfile, f"claim task {task_id} (retry)"):
            # Roll back the local move so the task isn't stuck in active
            # without the claim being published.
            try:
                os.replace(dst, src)
            except OSError:
                pass
            log(f"Could not publish claim for {task_id}, rolled back", logfile)
            return None

    task["id"] = task_id
    return task


def run_task(cfg, logfile, task):
    """Run one claimed task through cline. Returns result string."""
    task_id = task["id"]
    prompt = task.get("prompt", "")
    project_dir = task.get("project_dir") or cfg.get("default_project_dir") or os.getcwd()
    timeout = int(task.get("timeout_sec") or cfg.get("default_timeout_sec", 1800))
    heartbeat = int(cfg.get("heartbeat_sec", 30))
    cline_cmd = cfg.get("cline_cmd", "cline")
    mode_flag = "--yolo"  # auto-approve; headless by design

    if not os.path.isdir(project_dir):
        return "failed", f"project_dir does not exist: {project_dir}", 1

    task["started_at"] = utcnow()
    write_status(cfg, task_id, "queued", progress_note="starting cline")
    push(cfg, logfile, f"task {task_id}: queued")

    cline_log = os.path.join(cfg["repo_dir"], ".watcher-logs", f"{task_id}.log")
    os.makedirs(os.path.dirname(cline_log), exist_ok=True)

    cmd = [cline_cmd, mode_flag, prompt]
    if task.get("mode") == "plan":
        # plan mode hint goes into the prompt itself; cline CLI has no --plan flag
        pass

    log(f"Starting task {task_id} in {project_dir}", logfile)
    write_status(cfg, task_id, "running", progress_note="cline launched")
    push(cfg, logfile, f"task {task_id}: running")

    # Stream output to the log file while heartbeating status.
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=project_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError:
        msg = f"cline not found (tried '{cline_cmd}'). Set cline_cmd in config.json to the full path."
        log(msg, logfile)
        return "failed", msg, 127
    except Exception as e:  # noqa: BLE001
        msg = f"could not launch cline: {e}"
        log(msg, logfile)
        return "failed", msg, 1

    output_chunks = []
    last_heartbeat = time.time()
    log_truncated_note = False
    try:
        with open(cline_log, "w", encoding="utf-8") as lf:
            start = time.time()
            # Read line-by-line so a long run doesn't buffer everything.
            assert proc.stdout is not None
            while True:
                if time.time() - start > timeout:
                    proc.kill()
                    try:
                        proc.wait(timeout=15)
                    except Exception:  # noqa: BLE001
                        pass
                    output_chunks.append("\n[TIMEOUT after %ds]" % timeout)
                    lf.write("\n[TIMEOUT after %ds]\n" % timeout)
                    return "timeout", "".join(output_chunks), 124
                line = proc.stdout.readline()
                if line:
                    lf.write(line)
                    lf.flush()
                    output_chunks.append(line)
                    # Keep memory bounded on very long runs.
                    if len(output_chunks) > 20000 and not log_truncated_note:
                        output_chunks = output_chunks[-10000:]
                        log_truncated_note = True
                elif proc.poll() is not None:
                    rest = proc.stdout.read() or ""
                    if rest:
                        lf.write(rest)
                        output_chunks.append(rest)
                    break
                if time.time() - last_heartbeat >= heartbeat:
                    last_heartbeat = time.time()
                    write_status(
                        cfg,
                        task_id,
                        "running",
                        log_tail=tail_lines("".join(output_chunks)),
                        progress_note="cline working",
                    )
                    push(cfg, logfile, f"task {task_id}: heartbeat")
        rc = proc.wait()
    except Exception as e:  # noqa: BLE001
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass
        return "failed", f"watcher error while running cline: {e}\n{traceback.format_exc()}", 1

    full_output = "".join(output_chunks)
    result = "success" if rc == 0 else "failed"
    log(f"Task {task_id} finished: {result} (exit {rc})", logfile)
    return result, full_output, rc


def finish_task(cfg, logfile, task, result, output, exit_code):
    """Move task to done/, write final status, push."""
    task_id = task["id"]
    task["result"] = result
    task["exit_code"] = exit_code
    task["finished_at"] = utcnow()
    if result != "success":
        # Keep the error readable; full output stays in the local .watcher-logs file.
        task["error"] = tail_lines(output, 20) if output else "no output"

    repo = cfg["repo_dir"]
    src = os.path.join(repo, ACTIVE, f"{task_id}.json")
    dst = os.path.join(repo, DONE, f"{task_id}.json")
    # Task file may have a different original filename; find it.
    if not os.path.exists(src):
        for f in os.listdir(os.path.join(repo, ACTIVE)):
            if f.startswith(task_id) or f == f"{task_id}.json":
                src = os.path.join(repo, ACTIVE, f)
                break
    try:
        if os.path.exists(src):
            existing = read_json(src)
            existing.update(task)
            task = existing
            os.remove(src)
        write_json(dst, task)
    except OSError as e:
        log(f"Could not move task file for {task_id}: {e}", logfile)

    write_status(
        cfg,
        task_id,
        result,
        log_tail=tail_lines(output),
        progress_note=f"finished: {result} (exit {exit_code})",
    )
    push(cfg, logfile, f"task {task_id}: {result}")


def load_config(path):
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    cfg.setdefault("poll_interval_sec", 20)
    cfg.setdefault("cline_cmd", "cline")
    cfg.setdefault("default_timeout_sec", 1800)
    cfg.setdefault("heartbeat_sec", 30)
    if not cfg.get("repo_dir"):
        # Default: the repo this script lives in (bridge repo root).
        here = os.path.abspath(os.path.dirname(__file__))
        cfg["repo_dir"] = os.path.abspath(os.path.join(here, os.pardir))
    cfg["repo_dir"] = os.path.abspath(os.path.expandvars(os.path.expanduser(cfg["repo_dir"])))
    return cfg


def main():
    ap = argparse.ArgumentParser(description="Muse<->Cline bridge PC watcher")
    ap.add_argument("--config", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json"))
    ap.add_argument("--once", action="store_true", help="run one poll iteration then exit")
    args = ap.parse_args()

    if not os.path.isfile(args.config):
        print(f"Config not found: {args.config}")
        print("Copy config.example.json to config.json and edit it first.")
        sys.exit(2)
    cfg = load_config(args.config)

    for d in (PENDING, ACTIVE, DONE, STATUS):
        os.makedirs(os.path.join(cfg["repo_dir"], d), exist_ok=True)

    logfile = os.path.join(cfg["repo_dir"], ".watcher-logs", "watcher.log")
    os.makedirs(os.path.dirname(logfile), exist_ok=True)
    log(f"Watcher starting. repo={cfg['repo_dir']} poll={cfg['poll_interval_sec']}s", logfile)

    # Sanity: is this a git repo?
    rc, out = git(cfg, logfile, "rev-parse", "--is-inside-work-tree")
    if rc != 0:
        log(f"repo_dir is not a git repo: {cfg['repo_dir']}", logfile)
        sys.exit(2)

    while True:
        try:
            if not sync_repo(cfg, logfile):
                time.sleep(cfg["poll_interval_sec"])
                if args.once:
                    break
                continue

            pending = list_pending(cfg)
            if pending:
                task = claim_task(cfg, logfile, pending[0])
                if task is not None:
                    result, output, exit_code = run_task(cfg, logfile, task)
                    finish_task(cfg, logfile, task, result, output, exit_code)
            # else: idle

            if args.once:
                break
            time.sleep(cfg["poll_interval_sec"])
        except KeyboardInterrupt:
            log("Watcher stopped by user.", logfile)
            break
        except Exception:  # noqa: BLE001 - never die on unexpected errors
            log(f"Unexpected error in main loop:\n{traceback.format_exc()}", logfile)
            time.sleep(cfg["poll_interval_sec"])
            if args.once:
                break


if __name__ == "__main__":
    main()
