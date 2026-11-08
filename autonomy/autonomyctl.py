#!/usr/bin/env python3
"""Task-scoped leases and worktrees for parallel coding-agent sessions.

Copied from the portable kit /home/happier/autonomy (ADR 0002). Local adaptation:
workspace-create defaults to base origin/master. Independent task claims coexist;
the flock is held only for one atomic state transition.
"""

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time


DEFAULT_LEASE_SECONDS = 7200
DEFAULT_BASE = "origin/master"
VERSION = 2


class CoordinationError(Exception):
    pass


def git(repo, *args):
    try:
        return subprocess.check_output(
            ["git", "-C", str(repo), *args], text=True, stderr=subprocess.STDOUT
        ).strip()
    except subprocess.CalledProcessError as exc:
        raise CoordinationError(exc.output.strip() or "git command failed") from None


def repo_context(repo_arg):
    repo = Path(git(repo_arg, "rev-parse", "--show-toplevel")).resolve()
    common_text = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir")
    common = Path(common_text)
    if not common.is_absolute():
        common = (repo / common).resolve()
    return repo, common.resolve()


class Registry:
    def __init__(self, repo_arg):
        self.repo, common = repo_context(repo_arg)
        self.directory = common / "autonomy-coordination-v2"
        self.directory.mkdir(mode=0o700, exist_ok=True)
        self.lock_path = self.directory / "control.lock"
        self.state_path = self.directory / "state.json"

    def transaction(self, operation):
        with self.lock_path.open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            state = self._load()
            result = operation(state)
            self._save(state)
            return result

    def read(self):
        with self.lock_path.open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_SH)
            return self._load()

    def _load(self):
        if not self.state_path.exists():
            return {"version": VERSION, "tasks": {}, "resources": {}, "history": []}
        try:
            state = json.loads(self.state_path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise CoordinationError(f"invalid coordination state: {exc}") from None
        validate_state(state)
        return state

    def _save(self, state):
        validate_state(state)
        fd, tmp = tempfile.mkstemp(prefix="state-", dir=self.directory)
        try:
            with os.fdopen(fd, "w") as output:
                json.dump(state, output, ensure_ascii=False, sort_keys=True)
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(tmp, self.state_path)
            directory_fd = os.open(self.directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)


def validate_state(state):
    if not isinstance(state, dict) or set(state) != {"version", "tasks", "resources", "history"}:
        raise CoordinationError("malformed coordination state")
    if state["version"] != VERSION:
        raise CoordinationError("unsupported coordination state version")
    if not isinstance(state["tasks"], dict) or not isinstance(state["resources"], dict) or not isinstance(state["history"], list):
        raise CoordinationError("malformed coordination state collections")
    for task_id, claim in state["tasks"].items():
        validate_name(task_id, "task")
        validate_claim(claim)
    for resource, claim in state["resources"].items():
        validate_name(resource, "resource")
        if not isinstance(claim, dict) or set(claim) != {"task", "owner", "acquired_at", "heartbeat_at", "expires_at"}:
            raise CoordinationError("malformed resource claim")
        validate_name(claim["task"], "task")
        validate_owner(claim["owner"])
        validate_times(claim)


def validate_claim(claim):
    required = {
        "owner", "session", "acquired_at", "heartbeat_at", "expires_at", "runs",
        "workspace", "branch", "base_ref", "base_sha", "workspace_status"
    }
    if not isinstance(claim, dict) or set(claim) != required:
        raise CoordinationError("malformed task claim")
    validate_owner(claim["owner"])
    validate_times(claim)
    if claim["session"] is not None and not isinstance(claim["session"], str):
        raise CoordinationError("malformed session")
    if not isinstance(claim["runs"], list) or any(not isinstance(x, str) or not x.strip() for x in claim["runs"]):
        raise CoordinationError("malformed runs")
    for key in ("workspace", "branch", "base_ref", "base_sha"):
        if claim[key] is not None and not isinstance(claim[key], str):
            raise CoordinationError(f"malformed {key}")
    if claim["workspace_status"] not in (None, "provisioning", "ready", "failed"):
        raise CoordinationError("malformed workspace status")


def validate_times(claim):
    for key in ("acquired_at", "heartbeat_at", "expires_at"):
        if type(claim.get(key)) not in (int, float) or not 0 < claim[key] < 1e20:
            raise CoordinationError("malformed lease timestamp")


def validate_name(value, label):
    if not isinstance(value, str) or not value.strip() or len(value) > 200:
        raise CoordinationError(f"invalid {label}")


def validate_owner(value):
    validate_name(value, "owner")


def require_task(state, task, owner):
    claim = state["tasks"].get(task)
    if claim is None:
        raise CoordinationError("task is not claimed")
    if claim["owner"] != owner:
        raise CoordinationError("owner does not hold task claim")
    return claim


def new_claim(args, now):
    return {
        "owner": args.owner,
        "session": args.session,
        "acquired_at": now,
        "heartbeat_at": now,
        "expires_at": now + args.lease_seconds,
        "runs": [],
        "workspace": None,
        "branch": None,
        "base_ref": None,
        "base_sha": None,
        "workspace_status": None,
    }


def event(state, kind, **fields):
    state["history"].append({"event": kind, "at": time.time(), **fields})
    if len(state["history"]) > 500:
        del state["history"][:-500]


def command_claim(registry, args):
    now = time.time()
    def op(state):
        existing = state["tasks"].get(args.task)
        if existing is not None:
            suffix = " (expired; explicit recovery required)" if existing["expires_at"] <= now else ""
            raise CoordinationError(f"task already claimed by {existing['owner']}{suffix}")
        state["tasks"][args.task] = new_claim(args, now)
        event(state, "claimed", task=args.task, owner=args.owner)
        return state["tasks"][args.task]
    return registry.transaction(op)


def command_recover(registry, args):
    now = time.time()
    def op(state):
        previous = state["tasks"].get(args.task)
        if previous is None:
            raise CoordinationError("task is not claimed; use claim")
        if previous["expires_at"] > now:
            raise CoordinationError("task claim is not expired")
        replacement = new_claim(args, now)
        for key in ("workspace", "branch", "base_ref", "base_sha", "workspace_status"):
            replacement[key] = previous[key]
        state["tasks"][args.task] = replacement
        for resource, claim in state["resources"].items():
            if claim["task"] == args.task and claim["owner"] == previous["owner"]:
                claim["owner"] = args.owner
                claim["heartbeat_at"] = now
                claim["expires_at"] = now + args.lease_seconds
        event(state, "recovered", task=args.task, previous_owner=previous["owner"], owner=args.owner, confirmed_stopped=True)
        return replacement
    return registry.transaction(op)


def command_heartbeat(registry, args):
    now = time.time()
    def op(state):
        claim = require_task(state, args.task, args.owner)
        if claim["expires_at"] <= now:
            raise CoordinationError("task claim expired; explicit recovery required")
        claim["heartbeat_at"] = now
        claim["expires_at"] = now + args.lease_seconds
        if args.clear_runs:
            claim["runs"] = []
        elif args.run is not None:
            claim["runs"] = args.run
        for resource in state["resources"].values():
            if resource["task"] == args.task and resource["owner"] == args.owner:
                resource["heartbeat_at"] = now
                resource["expires_at"] = now + args.lease_seconds
        return claim
    return registry.transaction(op)


def command_resource_claim(registry, args):
    now = time.time()
    def op(state):
        task_claim = require_task(state, args.task, args.owner)
        if task_claim["expires_at"] <= now:
            raise CoordinationError("task claim expired; explicit recovery required")
        existing = state["resources"].get(args.resource)
        if existing is not None:
            if existing["task"] == args.task and existing["owner"] == args.owner:
                existing["heartbeat_at"] = now
                existing["expires_at"] = now + args.lease_seconds
                return existing
            suffix = " (expired; explicit recovery required)" if existing["expires_at"] <= now else ""
            raise CoordinationError(f"resource already claimed by task {existing['task']}{suffix}")
        claim = {"task": args.task, "owner": args.owner, "acquired_at": now,
                 "heartbeat_at": now, "expires_at": now + args.lease_seconds}
        state["resources"][args.resource] = claim
        event(state, "resource_claimed", resource=args.resource, task=args.task, owner=args.owner)
        return claim
    return registry.transaction(op)


def command_resource_release(registry, args):
    def op(state):
        require_task(state, args.task, args.owner)
        claim = state["resources"].get(args.resource)
        if claim is None:
            raise CoordinationError("resource is not claimed")
        if claim["task"] != args.task or claim["owner"] != args.owner:
            raise CoordinationError("owner does not hold resource claim")
        del state["resources"][args.resource]
        event(state, "resource_released", resource=args.resource, task=args.task, owner=args.owner)
        return {"released": args.resource}
    return registry.transaction(op)


def command_finish(registry, args):
    def op(state):
        claim = require_task(state, args.task, args.owner)
        if claim["runs"]:
            raise CoordinationError("active runs recorded; confirm stopped and clear runs before finish")
        resources = [name for name, value in state["resources"].items()
                     if value["task"] == args.task and value["owner"] == args.owner]
        for name in resources:
            del state["resources"][name]
        del state["tasks"][args.task]
        event(state, "finished", task=args.task, owner=args.owner, outcome=args.outcome,
              commit=args.commit, workspace=claim["workspace"], branch=claim["branch"],
              released_resources=resources)
        return {"task": args.task, "outcome": args.outcome, "commit": args.commit,
                "workspace": claim["workspace"], "branch": claim["branch"],
                "released_resources": resources}
    return registry.transaction(op)


def slug(value):
    result = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip()).strip("-.").lower()
    if not result:
        raise CoordinationError("task does not produce a usable worktree name")
    return result[:80]


def workspace_metadata(path):
    root = Path(git(path, "rev-parse", "--show-toplevel")).resolve()
    common_text = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")
    common = Path(common_text)
    if not common.is_absolute():
        common = (root / common).resolve()
    branch = git(root, "branch", "--show-current") or None
    sha = git(root, "rev-parse", "HEAD")
    return root, common.resolve(), branch, sha


def command_workspace_attach(registry, args):
    root, common, branch, sha = workspace_metadata(args.path)
    _, expected_common = repo_context(registry.repo)
    if common != expected_common:
        raise CoordinationError("workspace is not a linked worktree of the target repository")
    def op(state):
        claim = require_task(state, args.task, args.owner)
        for other_task, other in state["tasks"].items():
            if other_task != args.task and other["workspace"] == str(root):
                raise CoordinationError(f"workspace already assigned to task {other_task}")
        claim.update({"workspace": str(root), "branch": branch, "base_ref": args.base,
                      "base_sha": args.base_sha or sha, "workspace_status": "ready"})
        event(state, "workspace_attached", task=args.task, owner=args.owner,
              workspace=str(root), branch=branch)
        return claim
    return registry.transaction(op)


def command_workspace_create(registry, args):
    task_slug = slug(args.task)
    branch = args.branch or f"autonomy/{task_slug}"
    path = Path(args.path).expanduser().resolve() if args.path else (
        registry.repo.parent / ".autonomy-worktrees" / registry.repo.name / task_slug
    ).resolve()
    base_sha = git(registry.repo, "rev-parse", "--verify", f"{args.base}^{{commit}}")

    def reserve(state):
        claim = require_task(state, args.task, args.owner)
        if claim["workspace_status"] in ("provisioning", "ready"):
            raise CoordinationError("task already has a workspace")
        for other_task, other in state["tasks"].items():
            if other_task != args.task and (other["workspace"] == str(path) or other["branch"] == branch):
                raise CoordinationError(f"workspace or branch already assigned to task {other_task}")
        claim.update({"workspace": str(path), "branch": branch, "base_ref": args.base,
                      "base_sha": base_sha, "workspace_status": "provisioning"})
        return claim.copy()
    registry.transaction(reserve)

    try:
        if path.exists():
            raise CoordinationError("workspace path already exists")
        path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.check_output(
            ["git", "-C", str(registry.repo), "worktree", "add", "-b", branch,
             str(path), base_sha], text=True, stderr=subprocess.STDOUT
        )
        root, common, actual_branch, _ = workspace_metadata(path)
        _, expected_common = repo_context(registry.repo)
        if common != expected_common or actual_branch != branch:
            raise CoordinationError("created workspace failed validation")
    except (CoordinationError, subprocess.CalledProcessError) as exc:
        message = str(exc)
        if isinstance(exc, subprocess.CalledProcessError):
            message = exc.output.strip() or "git worktree add failed"
        def fail(state):
            claim = require_task(state, args.task, args.owner)
            if claim["workspace"] == str(path) and claim["workspace_status"] == "provisioning":
                claim["workspace_status"] = "failed"
            event(state, "workspace_failed", task=args.task, owner=args.owner, error=message[:500])
        registry.transaction(fail)
        raise CoordinationError(message) from None

    def ready(state):
        claim = require_task(state, args.task, args.owner)
        if claim["workspace"] != str(path) or claim["workspace_status"] != "provisioning":
            raise CoordinationError("workspace reservation changed during creation")
        claim["workspace_status"] = "ready"
        event(state, "workspace_created", task=args.task, owner=args.owner,
              workspace=str(root), branch=branch, base_sha=base_sha)
        return claim
    return registry.transaction(ready)


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=".", help="any path inside the target Git repository")
    sub = parser.add_subparsers(dest="command", required=True)

    def lease_args(p, session=False):
        p.add_argument("--task", required=True)
        p.add_argument("--owner", required=True)
        p.add_argument("--lease-seconds", type=int, default=DEFAULT_LEASE_SECONDS)
        if session:
            p.add_argument("--session")

    lease_args(sub.add_parser("claim"), session=True)
    recover = sub.add_parser("recover")
    lease_args(recover, session=True)
    recover.add_argument("--confirm-stopped", action="store_true", required=True)
    heartbeat = sub.add_parser("heartbeat")
    lease_args(heartbeat)
    heartbeat_runs = heartbeat.add_mutually_exclusive_group()
    heartbeat_runs.add_argument("--run", action="append", default=None)
    heartbeat_runs.add_argument("--clear-runs", action="store_true")

    resource_claim = sub.add_parser("resource-claim")
    lease_args(resource_claim)
    resource_claim.add_argument("--resource", required=True)
    resource_release = sub.add_parser("resource-release")
    resource_release.add_argument("--resource", required=True)
    resource_release.add_argument("--task", required=True)
    resource_release.add_argument("--owner", required=True)

    create = sub.add_parser("workspace-create")
    create.add_argument("--task", required=True)
    create.add_argument("--owner", required=True)
    create.add_argument("--base", default=DEFAULT_BASE)
    create.add_argument("--branch")
    create.add_argument("--path")
    attach = sub.add_parser("workspace-attach")
    attach.add_argument("--task", required=True)
    attach.add_argument("--owner", required=True)
    attach.add_argument("--path", required=True)
    attach.add_argument("--base")
    attach.add_argument("--base-sha")

    finish = sub.add_parser("finish")
    finish.add_argument("--task", required=True)
    finish.add_argument("--owner", required=True)
    finish.add_argument("--outcome", choices=("done", "blocked", "abandoned"), required=True)
    finish.add_argument("--commit")
    sub.add_parser("status")
    return parser


def main():
    args = build_parser().parse_args()
    if hasattr(args, "lease_seconds") and args.lease_seconds <= 0:
        raise CoordinationError("lease seconds must be positive")
    if hasattr(args, "task"):
        validate_name(args.task, "task")
    if hasattr(args, "owner"):
        validate_owner(args.owner)
    if hasattr(args, "resource"):
        validate_name(args.resource, "resource")
    registry = Registry(args.repo)
    handlers = {
        "claim": command_claim,
        "recover": command_recover,
        "heartbeat": command_heartbeat,
        "resource-claim": command_resource_claim,
        "resource-release": command_resource_release,
        "workspace-create": command_workspace_create,
        "workspace-attach": command_workspace_attach,
        "finish": command_finish,
    }
    if args.command == "status":
        result = registry.read()
        now = time.time()
        result = {**result,
                  "expired_tasks": sorted(k for k, v in result["tasks"].items() if v["expires_at"] <= now),
                  "expired_resources": sorted(k for k, v in result["resources"].items() if v["expires_at"] <= now)}
    else:
        result = handlers[args.command](registry, args)
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except CoordinationError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        sys.exit(1)
