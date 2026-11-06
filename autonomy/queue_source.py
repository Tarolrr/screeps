#!/usr/bin/env python3
"""Single definition of "queue has work" for coordination.release and automation_pause.

Source is chosen by autonomy/queue-source.json ("legacy" JSON registry or "github" issues).
Any access or data problem raises QueueError: an error is never an empty queue.
"""
import json
import os
from pathlib import Path
import re
import subprocess

CONFIG = Path(__file__).resolve().with_name("queue-source.json")
ROOT = Path(__file__).resolve().parent.parent
TIMEOUT = 60
STATUSES = {"status:ready", "status:in-progress", "status:blocked", "status:review"}
# Only labels that decide readiness are checked; priority:* and other labels are informational.
OTHER = {"needs:owner"}
KNOWN_PREFIXES = ("status:", "needs:")
NO_DEPS = {"none", "нет", "-", "–", "—"}
DEPENDS = re.compile(r"^[ \t]*Depends on:[ \t]*(.*?)[ \t]*$", re.IGNORECASE | re.MULTILINE)
REFS = re.compile(r"^#(\d+)$")


class QueueError(Exception):
    """Only fixed, non-secret codes belong here (gh stderr is never echoed)."""


def load_config(path=CONFIG):
    try:
        config = json.loads(Path(path).read_text())
    except (OSError, ValueError, UnicodeError):
        raise QueueError("queue_config_invalid") from None
    if (not isinstance(config, dict) or config.get("source") not in ("legacy", "github")
            or not isinstance(config.get("legacy_registry"), str)
            or not isinstance(config.get("github_repo"), str)
            or not re.fullmatch(r"[\w.-]+/[\w.-]+", config["github_repo"])):
        raise QueueError("queue_config_invalid")
    return config


def queue_has_work(root=ROOT, config_path=CONFIG, runner=None):
    """True if ready (all dependencies done) or in-progress/review work exists."""
    config = load_config(config_path)
    if config["source"] == "github":
        return github_has_work(config["github_repo"], runner)
    return legacy_has_work(Path(root) / config["legacy_registry"])


def legacy_has_work(path):
    """Blocked tasks and todo tasks depending on them do not keep a schedule alive."""
    try:
        tasks = json.loads(Path(path).read_text())["tasks"]
    except (OSError, ValueError, KeyError, TypeError, UnicodeError):
        raise QueueError("legacy_registry_invalid") from None
    if not isinstance(tasks, list):
        raise QueueError("legacy_registry_invalid")
    by_id = {}
    for task in tasks:
        if (not isinstance(task, dict) or not isinstance(task.get("id"), str)
                or task["id"] in by_id or task.get("status") not in {"todo", "in_progress", "blocked", "done"}
                or not isinstance(task.get("depends_on", []), list)):
            raise QueueError("legacy_registry_invalid")
        by_id[task["id"]] = task
    for task in tasks:
        if any(not isinstance(dep, str) or dep not in by_id for dep in task.get("depends_on", [])):
            raise QueueError("legacy_dependencies_invalid")
    check_acyclic({task_id: {"deps": task.get("depends_on", [])}
                   for task_id, task in by_id.items()}, "legacy_dependency_cycle")
    return any(task["status"] == "in_progress" or (
        task["status"] == "todo" and all(by_id[dep]["status"] == "done" for dep in task.get("depends_on", []))
    ) for task in tasks)


def run_gh(args):
    """Run `gh <args>` (argv list, no shell) and return stdout; stderr is never echoed."""
    env = dict(os.environ)
    env.pop("XDG_CONFIG_HOME", None)  # same gh invocation convention as DELEGATION.template.md
    env["GH_PROMPT_DISABLED"] = "1"
    try:
        done = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=TIMEOUT, env=env, check=False)
    except (OSError, subprocess.SubprocessError):
        raise QueueError("gh_unavailable") from None
    if done.returncode != 0:
        raise QueueError("gh_failed")
    return done.stdout


def read_json(runner, args):
    try:
        return json.loads(runner(args))
    except QueueError:
        raise
    except (ValueError, UnicodeError):
        raise QueueError("github_data_invalid") from None


def parse_dependencies(body):
    deps = set()
    for line in DEPENDS.findall(body):
        if line.strip().lower() in NO_DEPS:
            continue
        for token in re.split(r"[,\s]+", line.strip()):
            if not token:
                continue
            match = REFS.match(token)
            if not match:
                raise QueueError("github_dependency_invalid")
            deps.add(int(match.group(1)))
    return deps


def open_tasks(repo, runner):
    """All OPEN issues labelled task, fully paginated (no ceiling); closed issues are never listed."""
    pages = read_json(runner, ["api", "--paginate", "--slurp",
                               f"repos/{repo}/issues?state=open&labels=task&per_page=100"])
    if not isinstance(pages, list) or any(not isinstance(page, list) for page in pages):
        raise QueueError("github_data_invalid")
    tasks = {}
    for issue in (item for page in pages for item in page):
        if (not isinstance(issue, dict) or type(issue.get("number")) is not int
                or issue["number"] in tasks or issue.get("state") != "open"
                or not isinstance(issue.get("labels"), list)
                or not isinstance(issue.get("body") or "", str)):
            raise QueueError("github_data_invalid")
        if "pull_request" in issue:
            continue  # the issues endpoint also returns pull requests
        names = []
        for label in issue["labels"]:
            if not isinstance(label, dict) or not isinstance(label.get("name"), str):
                raise QueueError("github_data_invalid")
            names.append(label["name"])
        if "task" not in names:
            raise QueueError("github_data_invalid")
        if [n for n in names if n not in STATUSES | OTHER and n.startswith(KNOWN_PREFIXES)]:
            raise QueueError("github_unknown_label")
        status = [n for n in names if n in STATUSES]
        if len(status) != 1:
            raise QueueError("github_status_invalid")  # open issue needs exactly one status label
        number = issue["number"]
        deps = parse_dependencies(issue.get("body") or "")
        if number in deps:
            raise QueueError("github_dependency_invalid")
        tasks[number] = {"status": status[0], "owner": "needs:owner" in names, "deps": deps}
    return tasks


def check_acyclic(tasks, error="github_dependency_cycle"):
    """A cycle would silently look like nothing ready; report it instead."""
    state = {}  # number -> 1 visiting, 2 done
    for start in tasks:
        stack = [(start, iter(tasks[start]["deps"]))]
        state.setdefault(start, 1)
        while stack:
            node, deps = stack[-1]
            for dep in deps:
                if dep not in tasks or state.get(dep) == 2:
                    continue
                if state.get(dep) == 1:
                    raise QueueError(error)
                state[dep] = 1
                stack.append((dep, iter(tasks[dep]["deps"])))
                break
            else:
                state[node] = 2
                stack.pop()


def dependency_done(repo, runner, number, tasks, cache):
    """Done only if closed as completed; open, not planned, unknown or a PR are not done."""
    if number in tasks:
        return False
    if number not in cache:
        issue = read_json(runner, ["api", f"repos/{repo}/issues/{number}"])
        if (not isinstance(issue, dict) or issue.get("number") != number
                or issue.get("state") not in ("open", "closed")):
            raise QueueError("github_data_invalid")
        cache[number] = (issue["state"] == "closed" and issue.get("state_reason") == "completed"
                         and "pull_request" not in issue)
    return cache[number]


def github_has_work(repo, runner=None):
    runner = runner or run_gh
    tasks = open_tasks(repo, runner)
    check_acyclic(tasks)
    cache = {}
    for number, task in tasks.items():
        if task["status"] in ("status:in-progress", "status:review"):
            return True
        if (task["status"] == "status:ready" and not task["owner"]
                and all(dependency_done(repo, runner, dep, tasks, cache) for dep in sorted(task["deps"]))):
            return True
    return False
