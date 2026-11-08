#!/usr/bin/env python3
"""Copied from the portable kit tests; runs only against temporary repositories."""
import json
from pathlib import Path
import subprocess
import tempfile
import time
import unittest


SCRIPT = Path(__file__).resolve().with_name("autonomyctl.py")


class AutonomyCtlTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp.name) / "repo"
        self.repo.mkdir()
        self.git("init", "-b", "main")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Test")
        (self.repo / "README.md").write_text("base\n")
        self.git("add", "README.md")
        self.git("commit", "-m", "base")

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], text=True).strip()

    def cli(self, *args, ok=True):
        proc = subprocess.run(
            ["python3", str(SCRIPT), "--repo", str(self.repo), *args],
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        payload = json.loads(proc.stdout)
        if ok and proc.returncode != 0:
            self.fail(f"command failed: {payload}\n{proc.stderr}")
        if not ok and proc.returncode == 0:
            self.fail(f"command unexpectedly succeeded: {payload}")
        return payload

    def claim(self, task, owner, seconds=7200):
        return self.cli("claim", "--task", task, "--owner", owner,
                        "--lease-seconds", str(seconds))

    def test_different_tasks_can_be_claimed_concurrently(self):
        self.claim("ISSUE-1", "session-a")
        self.claim("ISSUE-2", "session-b")
        state = self.cli("status")["result"]
        self.assertEqual({"ISSUE-1", "ISSUE-2"}, set(state["tasks"]))

    def test_same_task_is_exclusive(self):
        self.claim("ISSUE-1", "session-a")
        failed = self.cli("claim", "--task", "ISSUE-1", "--owner", "session-b", ok=False)
        self.assertIn("already claimed", failed["error"])

    def test_expiry_requires_explicit_recovery(self):
        self.claim("ISSUE-1", "session-a", seconds=1)
        time.sleep(1.05)
        failed = self.cli("claim", "--task", "ISSUE-1", "--owner", "session-b", ok=False)
        self.assertIn("explicit recovery", failed["error"])
        self.cli("recover", "--task", "ISSUE-1", "--owner", "session-b",
                 "--confirm-stopped")
        state = self.cli("status")["result"]
        self.assertEqual("session-b", state["tasks"]["ISSUE-1"]["owner"])

    def test_named_resource_only_blocks_that_resource(self):
        self.claim("ISSUE-1", "session-a")
        self.claim("ISSUE-2", "session-b")
        self.cli("resource-claim", "--resource", "live-server", "--task", "ISSUE-1",
                 "--owner", "session-a")
        failed = self.cli("resource-claim", "--resource", "live-server", "--task", "ISSUE-2",
                          "--owner", "session-b", ok=False)
        self.assertIn("already claimed", failed["error"])
        self.cli("resource-claim", "--resource", "release-channel", "--task", "ISSUE-2",
                 "--owner", "session-b")

    def test_finish_releases_only_task_resources(self):
        self.claim("ISSUE-1", "session-a")
        self.claim("ISSUE-2", "session-b")
        self.cli("resource-claim", "--resource", "one", "--task", "ISSUE-1", "--owner", "session-a")
        self.cli("resource-claim", "--resource", "two", "--task", "ISSUE-2", "--owner", "session-b")
        self.cli("finish", "--task", "ISSUE-1", "--owner", "session-a", "--outcome", "done")
        state = self.cli("status")["result"]
        self.assertNotIn("ISSUE-1", state["tasks"])
        self.assertIn("ISSUE-2", state["tasks"])
        self.assertNotIn("one", state["resources"])
        self.assertIn("two", state["resources"])

    def test_finish_requires_recorded_runs_to_be_cleared(self):
        self.claim("ISSUE-1", "session-a")
        self.cli("heartbeat", "--task", "ISSUE-1", "--owner", "session-a", "--run", "worker-a")
        failed = self.cli("finish", "--task", "ISSUE-1", "--owner", "session-a",
                          "--outcome", "done", ok=False)
        self.assertIn("active runs", failed["error"])
        self.cli("heartbeat", "--task", "ISSUE-1", "--owner", "session-a", "--clear-runs")
        self.cli("finish", "--task", "ISSUE-1", "--owner", "session-a", "--outcome", "done")

    def test_create_and_attach_worktrees(self):
        self.claim("ISSUE-1", "session-a")
        path = Path(self.temp.name) / "worktree-one"
        result = self.cli("workspace-create", "--task", "ISSUE-1", "--owner", "session-a",
                          "--base", "main", "--path", str(path))["result"]
        self.assertEqual("ready", result["workspace_status"])
        self.assertEqual("autonomy/issue-1", result["branch"])
        self.assertEqual("autonomy/issue-1", subprocess.check_output(
            ["git", "-C", str(path), "branch", "--show-current"], text=True).strip())

        self.claim("ISSUE-2", "session-b")
        duplicate = self.cli("workspace-attach", "--task", "ISSUE-2", "--owner", "session-b",
                             "--path", str(path), ok=False)
        self.assertIn("already assigned", duplicate["error"])

        second_path = Path(self.temp.name) / "worktree-two"
        self.git("worktree", "add", "-b", "manual/issue-2", str(second_path), "main")
        attached = self.cli("workspace-attach", "--task", "ISSUE-2", "--owner", "session-b",
                            "--path", str(second_path))["result"]
        self.assertEqual(str(second_path.resolve()), attached["workspace"])


    def test_parallel_claims_of_different_tasks_all_succeed(self):
        procs = [subprocess.Popen(
            ["python3", str(SCRIPT), "--repo", str(self.repo), "claim",
             "--task", f"issue-{n}", "--owner", f"session-{n}"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for n in range(6)]
        self.assertEqual([0] * 6, [p.wait(timeout=20) for p in procs])
        for p in procs:
            p.stdout.close()
            p.stderr.close()
        state = self.cli("status")["result"]
        self.assertEqual({f"issue-{n}" for n in range(6)}, set(state["tasks"]))

    def test_parallel_claims_of_same_task_have_one_winner(self):
        procs = [subprocess.Popen(
            ["python3", str(SCRIPT), "--repo", str(self.repo), "claim",
             "--task", "issue-1", "--owner", f"session-{n}"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for n in range(4)]
        codes = sorted(p.wait(timeout=20) for p in procs)
        for p in procs:
            p.stdout.close()
            p.stderr.close()
        self.assertEqual([0, 1, 1, 1], codes)

    def test_default_base_is_origin_master(self):
        self.git("update-ref", "refs/remotes/origin/master", "HEAD")
        self.claim("issue-7", "session-a")
        path = Path(self.temp.name) / "worktree-default"
        result = self.cli("workspace-create", "--task", "issue-7", "--owner", "session-a",
                          "--path", str(path))["result"]
        self.assertEqual("origin/master", result["base_ref"])
        self.assertEqual(self.git("rev-parse", "HEAD"), result["base_sha"])
        self.assertEqual("autonomy/issue-7", result["branch"])

    def test_runtime_state_is_in_git_common_dir_v2(self):
        self.claim("issue-1", "session-a")
        state = self.repo / ".git" / "autonomy-coordination-v2" / "state.json"
        self.assertIn("issue-1", json.loads(state.read_text())["tasks"])
        self.assertFalse((self.repo / ".git" / "autonomy-coordination").exists())


if __name__ == "__main__":
    unittest.main()
