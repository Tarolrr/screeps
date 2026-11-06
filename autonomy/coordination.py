#!/usr/bin/env python3
"""Repository-local coordinator lease. A lease expiry never authorizes takeover."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

import queue_source

DEFAULT_LEASE_SECONDS = 7200


class JsonParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(message)


def main():
    finalization = None
    parser = JsonParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("acquire", "heartbeat", "release", "recover"):
        p = sub.add_parser(name)
        p.add_argument("--owner", required=True, help="unique session owner identifier")
        if name in ("acquire", "heartbeat", "recover"):
            p.add_argument("--lease-seconds", type=int, default=DEFAULT_LEASE_SECONDS)
            group = p.add_mutually_exclusive_group()
            group.add_argument("--run", action="append", default=None, help="active worker run reference; repeat as needed")
            group.add_argument("--clear-runs", action="store_true", help="record that no workers are active")
        if name == "recover":
            p.add_argument("--confirm-stopped", action="store_true", required=True,
                           help="confirm previous coordinator AND all workers are stopped")
    sub.add_parser("status")
    args = parser.parse_args()
    if hasattr(args, "owner") and not args.owner.strip():
        raise ValueError("owner must not be empty")
    if hasattr(args, "lease_seconds") and args.lease_seconds <= 0:
        raise ValueError("lease must be positive")
    if hasattr(args, "run") and args.run is not None and any(not x.strip() for x in args.run):
        raise ValueError("run references must not be empty")

    common = subprocess.check_output(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], text=True).strip()
    directory = Path(common) / "autonomy-coordination"
    directory.mkdir(mode=0o700, exist_ok=True)
    state_file = directory / "state.json"
    marker = directory / "initialized"
    with (directory / "control.lock").open("a+") as control:
        fcntl.flock(control, fcntl.LOCK_EX)
        if marker.exists():
            if not marker.is_file() or marker.read_text() != "coordination-v1\n" or not state_file.is_file():
                raise ValueError("missing or invalid initialized state; manual investigation required")
            state = json.loads(state_file.read_text())
            validate(state)
        else:
            if state_file.exists():
                raise ValueError("state exists without initialization marker; manual investigation required")
            # Marker is durable before state: interruption fails closed rather than
            # making a later process mistake partial initialization for a new lease.
            with marker.open("x") as output:
                output.write("coordination-v1\n")
                output.flush()
                os.fsync(output.fileno())
            sync_directory(directory)
            state = {"version": 1, "active": None, "audit": []}
            save(state_file, state)
        active = state["active"]
        now = time.time()
        if args.command == "status":
            result = {"state": state, "expired": bool(active and active["expires_at"] <= now)}
        else:
            if args.command == "acquire":
                if active is not None:
                    raise ValueError("coordinator already recorded; expiry does not permit takeover")
                state["active"] = lease(args, now)
            elif args.command == "recover":
                if active is None:
                    raise ValueError("nothing to recover; use acquire")
                state["audit"].append({"event": "recovered", "at": now, "previous": active,
                                       "new_owner": args.owner, "confirmed_stopped": True})
                state["active"] = lease(args, now)
            else:
                if active is None or active["owner"] != args.owner:
                    raise ValueError("owner does not hold coordinator lease")
                if args.command == "heartbeat":
                    if active["expires_at"] <= now:
                        raise ValueError("lease expired; explicit recovery required")
                    active["expires_at"] = now + args.lease_seconds
                    if args.clear_runs:
                        active["runs"] = []
                    elif args.run is not None:
                        active["runs"] = args.run
                else:
                    if active["runs"]:
                        raise ValueError("active worker runs recorded; confirm stopped and clear runs before release")
                    finalization = finalize_scheduled_release(active, args.owner, directory)
                    entry = {"event": "released", "at": time.time(), "previous": active}
                    if finalization is not None:
                        entry["automation_finalize"] = finalization
                    state["audit"].append(entry)
                    state["active"] = None
            save(state_file, state)
            result = {"state": state}
        ok = finalization is None or finalization.get("ok") is True
        if finalization is not None:
            result["automation_finalize"] = finalization
        print(json.dumps({"ok": ok, **result}, ensure_ascii=False))
        return 0 if ok else 1


def registry_has_work(path):
    """Legacy JSON registry check; the configured source is queue_source.queue_has_work."""
    try:
        return queue_source.legacy_has_work(path)
    except queue_source.QueueError as exc:
        raise ValueError(str(exc)) from None


def finalize_scheduled_release(active, owner, directory):
    origin = os.environ.get("SCREEPS_AUTOMATION_ORIGIN")
    automation_id = os.environ.get("SCREEPS_AUTOMATION_ID")
    if origin is None and automation_id is None:
        return None  # An ordinary manual coordinator release.
    try:
        import automation_pause
        if not all((automation_pause.AUTOMATION_ID, automation_pause.SERVER_ID, automation_pause.SERVER_URL)):
            return {"ok": False, "error": "automation_not_configured"}
        if origin != "scheduled" or automation_id != automation_pause.AUTOMATION_ID:
            return {"ok": False, "error": "scheduled_origin_mismatch"}
        repo = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
        if repo.resolve() != automation_pause.ROOT.resolve():
            return {"ok": False, "error": "scheduled_repository_mismatch"}
        try:
            has_work = queue_source.queue_has_work(repo)
        except queue_source.QueueError as exc:
            # Access/data failure is not an empty queue: no pause, lease still released.
            return {"ok": False, "error": str(exc)}
        if has_work:
            return {"ok": True, "action": "continue", "reason": "remaining_work"}
        # Already under the coordinator flock: do NOT invoke the helper subprocess,
        # which would try to take that same lock again.
        return {"action": "pause", **automation_pause.finalize_under_lock(active, owner, directory)}
    except Exception:
        # Lease cleanup still happens; never print auth-bearing exception text.
        return {"ok": False, "error": "scheduled_finalization_failed"}


def lease(args, now):
    return {"owner": args.owner, "acquired_at": now, "expires_at": now + args.lease_seconds,
            "runs": args.run or []}


def validate(state):
    if not isinstance(state, dict) or set(state) != {"version", "active", "audit"} or state["version"] != 1 or not isinstance(state["audit"], list):
        raise ValueError("malformed state")
    active = state["active"]
    if active is not None:
        if (not isinstance(active, dict) or set(active) != {"owner", "acquired_at", "expires_at", "runs"}
                or not isinstance(active["owner"], str) or not active["owner"].strip()
                or any(type(active[k]) not in (int, float) or not (0 < active[k] < 1e20) for k in ("acquired_at", "expires_at"))
                or not isinstance(active["runs"], list) or any(not isinstance(x, str) or not x.strip() for x in active["runs"])):
            raise ValueError("malformed active lease")
    if any(not isinstance(entry, dict) or entry.get("event") not in ("released", "recovered") or not isinstance(entry.get("previous"), dict) for entry in state["audit"]):
        raise ValueError("malformed audit")


def save(path, state):
    fd, tmp = tempfile.mkstemp(prefix="state-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(state, output, ensure_ascii=False, allow_nan=False)
            output.flush()
            os.fsync(output.fileno())
        os.replace(tmp, path)
        sync_directory(path.parent)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def sync_directory(path):
    directory_fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        sys.exit(1)
