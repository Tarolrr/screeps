#!/usr/bin/env python3
import json
import io
import os
from pathlib import Path
from contextlib import redirect_stdout
import subprocess
import sys
import tempfile
import time
import threading
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import automation_pause
automation_pause.AUTOMATION_ID = "testautomation"
automation_pause.SERVER_ID = "testserver"
automation_pause.SERVER_URL = "http://127.0.0.1:12345"
import coordination
import queue_source

_REAL_QUEUE_HAS_WORK = queue_source.queue_has_work


def legacy_queue(root):
    """Patch queue_has_work to use a temp legacy config, independent of the repo's queue-source.json and of gh."""
    config = Path(root) / "queue-source.json"
    config.write_text(json.dumps({"source": "legacy", "legacy_registry": "autonomy/state/tasks.json",
                                  "github_repo": "o/r"}))
    return patch.object(queue_source, "queue_has_work",
                        lambda repo, runner=None: _REAL_QUEUE_HAS_WORK(repo, config, runner))

SCRIPT = Path(__file__).with_name("coordination.py").resolve()


class CoordinationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = self.tmp.name
        subprocess.run(["git", "init", "-q", self.cwd], check=True)

    def tearDown(self):
        self.tmp.cleanup()

    def process(self, *args):
        env = dict(os.environ)
        env.pop("SCREEPS_AUTOMATION_ID", None)
        env.pop("SCREEPS_AUTOMATION_ORIGIN", None)
        return subprocess.Popen([sys.executable, str(SCRIPT), *args], cwd=self.cwd,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)

    def run_cli(self, *args):
        p = self.process(*args)
        out, err = p.communicate(timeout=10)
        self.assertFalse(err, err)
        return p.returncode, json.loads(out)

    def test_concurrent_acquire_foreign_release_and_runs(self):
        processes = [self.process("acquire", "--owner", name, "--run", name + "-worker") for name in ("a", "b")]
        results = [(p, p.communicate(timeout=10)) for p in processes]
        self.assertEqual(sorted(p.returncode for p, _ in results), [0, 1])
        success = next(json.loads(out) for p, (out, _) in results if p.returncode == 0)
        owner = success["state"]["active"]["owner"]
        self.assertEqual(success["state"]["active"]["runs"], [owner + "-worker"])
        other = "b" if owner == "a" else "a"
        self.assertEqual(self.run_cli("release", "--owner", other)[0], 1)
        self.assertEqual(self.run_cli("heartbeat", "--owner", owner, "--run", "next")[1]["state"]["active"]["runs"], ["next"])
        self.assertEqual(self.run_cli("release", "--owner", owner)[0], 1)
        self.assertEqual(self.run_cli("heartbeat", "--owner", owner, "--clear-runs")[0], 0)
        self.assertEqual(self.run_cli("release", "--owner", owner)[0], 0)

    def test_expiry_never_steals_and_recovery_audits(self):
        self.assertEqual(self.run_cli("acquire", "--owner", "old", "--lease-seconds", "1", "--run", "worker")[0], 0)
        time.sleep(1.1)
        self.assertTrue(self.run_cli("status")[1]["expired"])
        self.assertEqual(self.run_cli("acquire", "--owner", "new")[0], 1)
        self.assertEqual(self.run_cli("heartbeat", "--owner", "old")[0], 1)
        self.assertNotEqual(self.run_cli("recover", "--owner", "new")[0], 0)
        code, result = self.run_cli("recover", "--owner", "new", "--confirm-stopped")
        self.assertEqual(code, 0)
        self.assertEqual(result["state"]["audit"][-1]["previous"]["runs"], ["worker"])
        self.assertEqual(result["state"]["active"]["owner"], "new")

    def test_deleted_state_and_partial_initialization_fail_closed(self):
        self.run_cli("acquire", "--owner", "old")
        (Path(self.cwd) / ".git/autonomy-coordination/state.json").unlink()
        self.assertEqual(self.run_cli("acquire", "--owner", "new")[0], 1)
        self.assertEqual(self.run_cli("recover", "--owner", "new", "--confirm-stopped")[0], 1)
        self.assertEqual(self.run_cli("status")[0], 1)

    def test_malformed_state_fails_closed(self):
        self.run_cli("acquire", "--owner", "old")
        (Path(self.cwd) / ".git/autonomy-coordination/state.json").write_text('{"broken": true}')
        self.assertEqual(self.run_cli("acquire", "--owner", "new")[0], 1)
        self.assertEqual(self.run_cli("recover", "--owner", "new", "--confirm-stopped")[0], 1)

    def test_default_lease_is_two_hours_and_override_works(self):
        before = time.time()
        _, result = self.run_cli("acquire", "--owner", "a")
        active = result["state"]["active"]
        self.assertEqual(coordination.DEFAULT_LEASE_SECONDS, 7200)
        self.assertEqual(round(active["expires_at"] - active["acquired_at"]), 7200)
        self.assertGreaterEqual(active["acquired_at"], before)
        _, result = self.run_cli("heartbeat", "--owner", "a", "--lease-seconds", "300")
        active = result["state"]["active"]
        self.assertLess(active["expires_at"] - time.time(), 301)
        _, result = self.run_cli("heartbeat", "--owner", "a")
        self.assertGreater(result["state"]["active"]["expires_at"] - time.time(), 7100)
        code, result = self.run_cli("acquire", "--owner", "b")
        self.assertEqual(code, 1)  # a live lease is never taken over

    def test_registry_ready_and_blocked_dependencies(self):
        path = Path(self.cwd) / "tasks.json"
        tasks = [{"id": "ask", "status": "blocked", "blocked_reason": "needs_clarification"},
                 {"id": "wait", "status": "todo", "depends_on": ["ask"]},
                 {"id": "finished", "status": "done"}]
        path.write_text(json.dumps({"tasks": tasks}))
        self.assertFalse(coordination.registry_has_work(path))
        tasks.append({"id": "independent", "status": "todo", "depends_on": ["finished"]})
        path.write_text(json.dumps({"tasks": tasks}))
        self.assertTrue(coordination.registry_has_work(path))
        tasks[-1]["status"] = "in_progress"
        path.write_text(json.dumps({"tasks": tasks}))
        self.assertTrue(coordination.registry_has_work(path))
        tasks[-1]["depends_on"] = ["missing"]
        path.write_text(json.dumps({"tasks": tasks}))
        with self.assertRaises(ValueError):
            coordination.registry_has_work(path)

    def test_scheduled_release_pauses_empty_queue_and_releases_even_on_failure(self):
        for ok in (True, False):
            self.assertEqual(self.run_cli("acquire", "--owner", "worker")[0], 0)
            registry = Path(self.cwd) / "autonomy/state/tasks.json"
            registry.parent.mkdir(parents=True, exist_ok=True)
            registry.write_text(json.dumps({"tasks": [
                {"id": "done", "status": "done"},
                {"id": "ask", "status": "blocked", "blocked_reason": "needs_clarification"},
                {"id": "dependent", "status": "todo", "depends_on": ["ask"]},
            ]}))
            result = {"ok": True, "id": automation_pause.AUTOMATION_ID, "enabled": False} if ok else {
                "ok": False, "error": "http_401", "phase": "pause"
            }
            previous = os.getcwd()
            output = io.StringIO()
            try:
                os.chdir(self.cwd)
                with patch.dict(os.environ, {
                    "SCREEPS_AUTOMATION_ID": automation_pause.AUTOMATION_ID,
                    "SCREEPS_AUTOMATION_ORIGIN": "scheduled",
                }), legacy_queue(self.cwd), patch.object(automation_pause, "ROOT", Path(self.cwd)), patch.object(
                    automation_pause, "finalize_under_lock", return_value=result
                ) as pause, patch.object(sys, "argv", ["coordination.py", "release", "--owner", "worker"]), redirect_stdout(output):
                    code = coordination.main()
                    self.assertEqual(code, 0 if ok else 1)
                    pause.assert_called_once()
            finally:
                os.chdir(previous)
            response = json.loads(output.getvalue())
            self.assertEqual(response["ok"], ok)
            self.assertIsNone(response["state"]["active"])
            self.assertEqual(response["automation_finalize"]["ok"], ok)
            self.assertEqual(self.run_cli("status")[1]["state"]["audit"][-1]["automation_finalize"]["ok"], ok)

    def test_manual_release_and_remaining_work_do_not_pause(self):
        active = {"owner": "worker"}
        with patch.dict(os.environ, {}, clear=True), patch.object(automation_pause, "finalize_under_lock") as pause:
            self.assertIsNone(coordination.finalize_scheduled_release(active, "worker", Path(self.cwd)))
            pause.assert_not_called()
        registry = Path(self.cwd) / "autonomy/state/tasks.json"
        registry.parent.mkdir(parents=True)
        registry.write_text(json.dumps({"tasks": [{"id": "next", "status": "todo"}]}))
        previous = os.getcwd()
        try:
            os.chdir(self.cwd)
            with patch.dict(os.environ, {
                "SCREEPS_AUTOMATION_ID": automation_pause.AUTOMATION_ID,
                "SCREEPS_AUTOMATION_ORIGIN": "scheduled",
            }), legacy_queue(self.cwd), patch.object(automation_pause, "ROOT", Path(self.cwd)), patch.object(
                automation_pause, "finalize_under_lock"
            ) as pause:
                result = coordination.finalize_scheduled_release(active, "worker", Path(self.cwd))
                self.assertEqual(result["action"], "continue")
                pause.assert_not_called()
                os.environ["SCREEPS_AUTOMATION_ID"] = "foreign"
                self.assertFalse(coordination.finalize_scheduled_release(active, "worker", Path(self.cwd))["ok"])
                pause.assert_not_called()
        finally:
            os.chdir(previous)

    def test_scheduled_release_full_http_path_uses_held_flock_without_deadlock(self):
        self.assertEqual(self.run_cli("acquire", "--owner", "worker")[0], 0)
        registry = Path(self.cwd) / "autonomy/state/tasks.json"
        registry.parent.mkdir(parents=True)
        registry.write_text(json.dumps({"tasks": [{"id": "completed-work", "status": "done"}]}))
        calls = []

        class Handler(BaseHTTPRequestHandler):
            def respond(self):
                calls.append((self.command, self.path))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({"id": automation_pause.AUTOMATION_ID, "enabled": False}).encode())

            do_POST = respond
            do_GET = respond

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        previous = os.getcwd()
        output = io.StringIO()
        try:
            os.chdir(self.cwd)
            with patch.dict(os.environ, {
                "SCREEPS_AUTOMATION_ID": automation_pause.AUTOMATION_ID,
                "SCREEPS_AUTOMATION_ORIGIN": "scheduled",
            }), legacy_queue(self.cwd), patch.object(automation_pause, "ROOT", Path(self.cwd)), patch.object(
                automation_pause, "SERVER_URL", f"http://127.0.0.1:{server.server_port}"
            ), patch.object(automation_pause, "load_token", return_value="synthetic"), patch.object(
                sys, "argv", ["coordination.py", "release", "--owner", "worker"]
            ), redirect_stdout(output):
                self.assertEqual(coordination.main(), 0)
            result = json.loads(output.getvalue())
            self.assertIsNone(result["state"]["active"])
            self.assertTrue(result["automation_finalize"]["ok"])
            self.assertEqual(calls, [
                ("POST", f"/v2/automations/{automation_pause.AUTOMATION_ID}/pause"),
                ("GET", f"/v2/automations/{automation_pause.AUTOMATION_ID}"),
            ])
        finally:
            os.chdir(previous)
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
