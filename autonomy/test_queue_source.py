#!/usr/bin/env python3
import io
import json
import os
from contextlib import redirect_stdout
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import automation_pause
automation_pause.AUTOMATION_ID = "testautomation"
automation_pause.SERVER_ID = "testserver"
automation_pause.SERVER_URL = "http://127.0.0.1:12345"
import queue_source as q


def issue(number, state="OPEN", labels=("task", "status:ready"), body="", reason=None, pull=False):
    data = {"number": number, "state": state.lower(), "labels": [{"name": n} for n in labels], "body": body,
            "state_reason": reason}
    if pull:
        data["pull_request"] = {}
    return data


def fake_gh(issues, pages=None, calls=None):
    """Mimic gh: the paginated open list holds OPEN task issues; other numbers are read one by one."""
    by_number = {i["number"]: i for i in issues}
    listed = [i for i in issues if i["state"] == "open" and "task" in [l["name"] for l in i["labels"]]]

    def runner(args):
        if calls is not None:
            calls.append(args)
        if args[:3] == ["api", "--paginate", "--slurp"]:
            self_pages = pages or [listed[n:n + 100] for n in range(0, len(listed), 100)] or [[]]
            return json.dumps(self_pages)
        number = int(args[1].rsplit("/", 1)[1])
        if number not in by_number:
            raise q.QueueError("gh_failed")  # 404
        return json.dumps(by_number[number])
    return runner


def has_work(issues, **kwargs):
    return q.github_has_work("o/r", fake_gh(issues, **kwargs))


class GithubQueueTest(unittest.TestCase):
    def test_ready_in_progress_review_hold_schedule(self):
        self.assertTrue(has_work([issue(1)]))
        self.assertTrue(has_work([issue(1, labels=("task", "status:in-progress"))]))
        self.assertTrue(has_work([issue(1, labels=("task", "status:review", "priority:high"))]))

    def test_blocked_and_dependents_are_not_ready(self):
        blocked = issue(1, labels=("task", "status:blocked", "needs:owner"))
        dependent = issue(2, body="Goal\n\nDepends on: #1\n")
        self.assertFalse(has_work([blocked, dependent]))
        self.assertFalse(has_work([issue(3, labels=("task", "status:ready", "needs:owner"))]))

    def test_completed_dependency_unblocks_but_closed_task_holds_nothing(self):
        done = issue(1, state="CLOSED", labels=("task", "status:in-progress"), reason="completed")
        self.assertFalse(has_work([done]))
        self.assertTrue(has_work([done, issue(2, body="Depends on: #1")]))
        self.assertFalse(has_work([done, issue(2, labels=("task", "status:blocked"), body="Depends on: #1")]))

    def test_not_planned_or_unknown_close_does_not_satisfy_dependency(self):
        for reason in ("not_planned", None, "reopened", "duplicate"):
            with self.subTest(reason):
                closed = issue(1, state="CLOSED", labels=("task",), reason=reason)
                self.assertFalse(has_work([closed, issue(2, body="Depends on: #1")]))

    def test_dependency_may_be_closed_non_task_issue_but_not_pull_request(self):
        plain = issue(1, state="CLOSED", labels=(), reason="completed")
        self.assertTrue(has_work([plain, issue(2, body="Depends on: #1")]))
        pull = issue(1, state="CLOSED", labels=(), reason="completed", pull=True)
        self.assertFalse(has_work([pull, issue(2, body="Depends on: #1")]))
        self.assertFalse(has_work([issue(1, labels=("bug",)), issue(2, body="Depends on: #1")]))  # open non-task

    def test_open_dependency_blocks_and_multiple_refs(self):
        issues = [issue(1, labels=("task", "status:blocked")), issue(2, state="CLOSED", labels=("task",), reason="completed"),
                  issue(3, body="x\nDepends on: #1, #2\n<!-- screeps-task-id: legacy -->")]
        self.assertFalse(has_work(issues))
        issues[0].update(state="closed", state_reason="completed")
        self.assertTrue(has_work(issues))

    def test_priority_labels_are_informational(self):
        self.assertTrue(has_work([issue(1, labels=("task", "status:ready", "priority:low"))]))
        self.assertTrue(has_work([issue(1, labels=("task", "status:ready", "priority:whatever", "bug"))]))

    def test_template_placeholder_and_no_dependencies_are_valid(self):
        template = "Task\nDepends on: none"
        self.assertEqual(q.parse_dependencies(template), set())
        for body in ("Depends on:", "Depends on: none", "Depends on: —", "<!-- Depends on: #N -->"):
            self.assertEqual(q.parse_dependencies(body), set(), body)
        self.assertTrue(has_work([issue(1, body=template)]))

    def test_cycles_are_errors(self):
        for issues in ([issue(1, body="Depends on: #2"), issue(2, body="Depends on: #1")],
                       [issue(1, body="Depends on: #2"), issue(2, body="Depends on: #3"),
                        issue(3, body="Depends on: #1")]):
            with self.assertRaises(q.QueueError) as caught:
                has_work(issues)
            self.assertEqual(str(caught.exception), "github_dependency_cycle")
        chain = [issue(1, labels=("task", "status:blocked")), issue(2, body="Depends on: #1"),
                 issue(3, body="Depends on: #1, #2")]
        self.assertFalse(has_work(chain))  # diamond is not a cycle

    def test_many_closed_issues_do_not_matter_and_open_pages_are_followed(self):
        closed = [issue(n, state="CLOSED", labels=("task",), reason="completed") for n in range(1, 701)]
        calls = []
        self.assertTrue(has_work(closed + [issue(701, body="Depends on: #700")], calls=calls))
        self.assertEqual(len(calls), 2)  # one list call + one targeted dependency read
        many_open = [issue(n, labels=("task", "status:blocked")) for n in range(1, 251)]
        pages = [many_open[:100], many_open[100:200], many_open[200:]]
        self.assertFalse(has_work(many_open, pages=pages))
        self.assertTrue(has_work(many_open + [issue(251)], pages=pages + [[issue(251)]]))

    def test_pull_requests_in_open_list_are_ignored(self):
        self.assertFalse(has_work([issue(1, pull=True)]))

    def test_fail_closed_on_bad_data(self):
        bad = {
            "unknown status label": [issue(1, labels=("task", "status:later"))],
            "unknown needs label": [issue(1, labels=("task", "status:ready", "needs:money"))],
            "no status": [issue(1, labels=("task",))],
            "two statuses": [issue(1, labels=("task", "status:ready", "status:blocked"))],
            "missing dependency": [issue(1, body="Depends on: #9")],
            "garbled dependency": [issue(1, body="Depends on: soon")],
            "cross repo dependency": [issue(1, body="Depends on: a/b#9")],
            "self dependency": [issue(1, body="Depends on: #1")],
            "duplicate": [issue(1), issue(1)],
            "malformed labels": [dict(issue(1), labels=["task"])],
            "bad body": [dict(issue(1), body=5)],
        }
        for name, data in bad.items():
            with self.subTest(name), self.assertRaises(q.QueueError):
                q.github_has_work("o/r", lambda args, data=data: json.dumps([data]) if args[0] == "api" and
                                  "--slurp" in args else "{}")
        for name, output in (("not a list", {"issues": []}), ("page not a list", [{}]),
                             ("not json", "not json")):
            with self.subTest(name), self.assertRaises(q.QueueError):
                q.github_has_work("o/r", lambda args, output=output: output if isinstance(output, str)
                                  else json.dumps(output))
        wrong = lambda args: json.dumps([[issue(1, body="Depends on: #5")]]) if "--slurp" in args else json.dumps(
            issue(6, state="CLOSED", reason="completed"))
        with self.assertRaises(q.QueueError):
            q.github_has_work("o/r", wrong)

    def test_gh_failure_is_error_not_empty_queue(self):
        failed = subprocess.CompletedProcess([], 1, stdout="", stderr="TOKEN-SECRET")
        with patch.object(q.subprocess, "run", return_value=failed):
            with self.assertRaises(q.QueueError) as caught:
                q.github_has_work("o/r")
        self.assertNotIn("SECRET", str(caught.exception))
        with patch.object(q.subprocess, "run", side_effect=FileNotFoundError):
            with self.assertRaises(q.QueueError):
                q.github_has_work("o/r")

    def test_gh_command_paginates_open_task_issues_only(self):
        done = subprocess.CompletedProcess([], 0, stdout="[[]]", stderr="")
        with patch.object(q.subprocess, "run", return_value=done) as run:
            self.assertFalse(q.github_has_work("o/r"))
        command = run.call_args.args[0]
        self.assertEqual(command[:4], ["gh", "api", "--paginate", "--slurp"])
        self.assertIn("state=open", command[4])
        self.assertIn("labels=task", command[4])
        self.assertNotIn("--limit", command)


class ConfigTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.config = self.root / "queue-source.json"
        (self.root / "reg.json").write_text(json.dumps({"tasks": [{"id": "a", "status": "done"}]}))

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, source):
        self.config.write_text(json.dumps({"source": source, "legacy_registry": "reg.json", "github_repo": "o/r"}))

    def test_switch_by_config_and_no_silent_fallback(self):
        self.write("legacy")
        self.assertFalse(q.queue_has_work(self.root, self.config))
        self.write("github")
        with patch.object(q, "run_gh", side_effect=q.QueueError("gh_failed")):
            with self.assertRaises(q.QueueError):  # legacy file says "empty" but must not be used
                q.queue_has_work(self.root, self.config)
        self.assertTrue(q.queue_has_work(self.root, self.config, fake_gh([issue(7)])))

    def test_bad_config_and_registry_fail_closed(self):
        for text in ("", "{}", json.dumps({"source": "x", "legacy_registry": "r", "github_repo": "o/r"}),
                     json.dumps({"source": "github", "legacy_registry": "r", "github_repo": "o r"})):
            self.config.write_text(text)
            with self.assertRaises(q.QueueError):
                q.queue_has_work(self.root, self.config)
        self.write("legacy")
        (self.root / "reg.json").write_text("{")
        with self.assertRaises(q.QueueError):
            q.queue_has_work(self.root, self.config)

    def test_repository_config_is_valid(self):
        self.assertIn(q.load_config()["source"], ("legacy", "github"))


class LegacyCycleTest(unittest.TestCase):
    def write_registry(self, path, dependencies):
        path.write_text(json.dumps({"tasks": [
            {"id": name, "status": "todo", "depends_on": deps}
            for name, deps in dependencies.items()
        ]}))

    def test_self_and_multinode_cycles_fail_even_with_other_ready_work(self):
        for dependencies in ({"a": ["a"]}, {"a": ["b"], "b": ["a"]},
                             {"a": ["b"], "b": ["c"], "c": ["a"], "ready": []}):
            with self.subTest(dependencies=dependencies), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "tasks.json"
                self.write_registry(path, dependencies)
                with self.assertRaises(q.QueueError) as caught:
                    q.legacy_has_work(path)
                self.assertEqual(str(caught.exception), "legacy_dependency_cycle")

    def test_acyclic_diamond_is_valid(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "tasks.json"
            self.write_registry(path, {"a": [], "b": ["a"], "c": ["a"], "d": ["b", "c"]})
            self.assertTrue(q.legacy_has_work(path))

    def test_scheduled_finalize_does_not_pause_for_cyclic_registry(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write_registry(root / "reg.json", {"a": ["b"], "b": ["a"]})
            config = root / "queue-source.json"
            config.write_text(json.dumps({"source": "legacy", "legacy_registry": "reg.json", "github_repo": "o/r"}))
            real_queue_has_work = q.queue_has_work
            env = {"SCREEPS_AUTOMATION_ID": automation_pause.AUTOMATION_ID,
                   "SCREEPS_AUTOMATION_ORIGIN": "scheduled"}
            with patch.dict(os.environ, env), idle_registry(), patch.object(
                    automation_pause, "ROOT", root), patch.object(
                    q, "queue_has_work", side_effect=lambda repo: real_queue_has_work(repo, config)), patch.object(
                    automation_pause, "pause") as pause, patch.object(automation_pause, "load_token") as auth:
                with self.assertRaisesRegex(automation_pause.PauseError, "^legacy_dependency_cycle$"):
                    automation_pause.finalize("w", None)
            pause.assert_not_called()
            auth.assert_not_called()


def idle_registry():
    """Stand-in for an autonomyctl registry with no task claims and no receipt."""
    registry = Mock()
    registry.read.return_value = {"version": 2, "tasks": {}, "resources": {}, "history": []}
    registry.directory = Path("/nonexistent-autonomy-registry")
    return patch.object(automation_pause, "open_registry", return_value=registry)


class ConsumersTest(unittest.TestCase):
    def test_finalize_does_not_pause_on_queue_error_and_continues_on_work(self):
        env = {"SCREEPS_AUTOMATION_ID": automation_pause.AUTOMATION_ID, "SCREEPS_AUTOMATION_ORIGIN": "scheduled"}
        for value in (q.QueueError("gh_failed"), True):
            kwargs = {"side_effect": value} if isinstance(value, Exception) else {"return_value": value}
            with patch.dict(os.environ, env), idle_registry(), patch.object(
                    q, "queue_has_work", **kwargs), patch.object(automation_pause, "pause") as pause:
                if isinstance(value, Exception):
                    with self.assertRaisesRegex(automation_pause.PauseError, "^gh_failed$"):
                        automation_pause.finalize("w", None)
                else:
                    self.assertEqual(automation_pause.finalize("w", None),
                                     {"ok": True, "action": "continue", "reason": "remaining_work"})
                pause.assert_not_called()

    def test_helper_refuses_pause_on_work_or_queue_error(self):
        for patched, error in ((dict(return_value=True), "queue_has_work"),
                               (dict(side_effect=q.QueueError("gh_failed")), "gh_failed")):
            with idle_registry(), patch.object(q, "queue_has_work", **patched), patch.object(
                    automation_pause, "pause") as pause:
                output = io.StringIO()
                with redirect_stdout(output):
                    code = automation_pause.main(["--owner", "w"])
                self.assertEqual(code, 1)
                self.assertEqual(json.loads(output.getvalue())["error"], error)
                pause.assert_not_called()


if __name__ == "__main__":
    unittest.main()
