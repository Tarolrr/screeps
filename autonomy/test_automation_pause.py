#!/usr/bin/env python3
"""Offline checks use fake credentials and HTTP responses, never real automation."""
from contextlib import redirect_stdout
import fcntl
import io
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import automation_pause as helper
helper.AUTOMATION_ID = "testautomation"
helper.SERVER_ID = "testserver"
helper.SERVER_URL = "http://127.0.0.1:12345"


TOKEN = "unit-test-token"


class Response:
    status = 200

    def __init__(self, value):
        self.raw = json.dumps(value).encode()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read(self, size):
        return self.raw[:size]


class AutomationPauseTest(unittest.TestCase):
    def cli(self, *args):
        output = io.StringIO()
        with redirect_stdout(output):
            code = helper.main(args)
        text = output.getvalue()
        self.assertNotIn(TOKEN, text)
        return code, json.loads(text)

    def test_json_auth_matches_cli_and_never_accepts_whole_file_as_token(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            helper.os.environ, {"HAPPIER_HOME_DIR": tmp, "HAPPIER_ACTIVE_SERVER_ID": helper.SERVER_ID}
        ):
            path = Path(tmp) / "servers" / helper.SERVER_ID / "access.key"
            path.parent.mkdir(parents=True)
            for extra in ({"encryption": None}, {"secret": "synthetic"}, {"encryption": {}}):
                path.write_text(json.dumps({"token": TOKEN, **extra}))
                self.assertEqual(helper.load_token(), TOKEN)
            for bad in (TOKEN, '{"token": "line\\nbreak"}', '{"token": ""}', '{}'):
                path.write_text(bad)
                with self.assertRaises(helper.PauseError):
                    helper.load_token()

    def test_check_has_no_http_and_wrong_target_never_reads_credentials(self):
        with patch.object(helper, "load_token", return_value=TOKEN) as auth, patch.object(
            helper, "open_registry"
        ) as guard, patch.object(helper.urllib.request, "build_opener") as opener:
            code, result = self.cli("--check")
            self.assertEqual(code, 0)
            self.assertIs(result["network"], False)
            guard.assert_not_called()
            opener.assert_not_called()
            auth.reset_mock()
            code, result = self.cli("--automation-id", "another-project", "--check")
            self.assertEqual(code, 1)
            self.assertEqual(result["error"], "automation_id_mismatch")
            auth.assert_not_called()

    def test_pause_is_post_then_get_without_preflight_and_only_allowlisted_output(self):
        for wrapped in (False, True):
            record = {"id": helper.AUTOMATION_ID, "enabled": False, "secret": TOKEN, "template": TOKEN}
            opener = Mock()
            opener.open.side_effect = [Response({"secret": TOKEN}), Response(
                {"automation": record} if wrapped else record
            )]
            result = helper.pause(TOKEN, opener)
            self.assertEqual(result, {"ok": True, "id": helper.AUTOMATION_ID, "enabled": False})
            requests = [call.args[0] for call in opener.open.call_args_list]
            self.assertEqual([req.get_method() for req in requests], ["POST", "GET"])
            self.assertEqual([req.full_url for req in requests], [
                f"{helper.SERVER_URL}/v2/automations/{helper.AUTOMATION_ID}/pause",
                f"{helper.SERVER_URL}/v2/automations/{helper.AUTOMATION_ID}",
            ])
            self.assertTrue(all(req.get_header("Authorization") == f"Bearer {TOKEN}" for req in requests))

    def test_get_after_post_must_confirm_same_id_and_literal_false(self):
        for record in ({"id": helper.AUTOMATION_ID, "enabled": True},
                       {"id": "another-project", "enabled": False},
                       {"id": helper.AUTOMATION_ID, "enabled": "false"}, {}):
            opener = Mock()
            opener.open.side_effect = [Response({}), Response(record)]
            result = helper.pause(TOKEN, opener)
            self.assertFalse(result["ok"])
            self.assertTrue(result["pause_accepted"])
            self.assertEqual(result["phase"], "verify")

    def test_http_errors_stop_without_retry_or_secret_output(self):
        error = urllib.error.HTTPError("http://localhost", 401, TOKEN, {}, io.BytesIO(TOKEN.encode()))
        opener = Mock()
        opener.open.side_effect = error
        with self.assertRaisesRegex(helper.PauseError, "^http_401$"):
            helper.pause(TOKEN, opener)
        self.assertEqual(opener.open.call_count, 1)
        opener.reset_mock()
        opener.open.side_effect = [Response({}), error]
        result = helper.pause(TOKEN, opener)
        self.assertEqual(result["error"], "http_401")
        self.assertEqual(result["phase"], "verify")
        self.assertNotIn(TOKEN, json.dumps(result))

    def test_bad_readback_and_network_failure_do_not_claim_pause(self):
        for bad in (b"not-json", b"x" * (helper.MAX_JSON_BYTES + 1)):
            response = Response({})
            response.raw = bad
            opener = Mock()
            opener.open.side_effect = [Response({}), response]
            self.assertFalse(helper.pause(TOKEN, opener)["ok"])
        opener = Mock()
        opener.open.side_effect = urllib.error.URLError(TOKEN)
        with self.assertRaisesRegex(helper.PauseError, "^request_failed$"):
            helper.pause(TOKEN, opener)

    def test_redirect_is_not_followed_with_authorization(self):
        calls = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                calls.append(self.path)
                self.send_response(302)
                self.send_header("Location", "/another-endpoint")
                self.end_headers()

            def do_GET(self):
                calls.append(self.path)
                self.send_response(200)
                self.end_headers()

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), helper.NoRedirect())
            with patch.object(helper, "SERVER_URL", f"http://127.0.0.1:{server.server_port}"):
                with self.assertRaisesRegex(helper.PauseError, "^http_302$"):
                    helper.pause(TOKEN, opener)
            self.assertEqual(calls, [f"/v2/automations/{helper.AUTOMATION_ID}/pause"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def make_repo(self, tmp):
        subprocess.run(["git", "init", "-q", tmp], check=True)
        return helper.autonomyctl.Registry(tmp)

    def claim(self, registry, task, owner, seconds=1200, runs=()):
        def op(state):
            now = time.time()
            state["tasks"][task] = {
                "owner": owner, "session": None, "acquired_at": now, "heartbeat_at": now,
                "expires_at": now + seconds, "runs": list(runs), "workspace": None, "branch": None,
                "base_ref": None, "base_sha": None, "workspace_status": None}
        registry.transaction(op)

    def test_cli_with_json_credentials_task_claim_and_local_http_server(self):
        calls = []

        class Handler(BaseHTTPRequestHandler):
            def respond(self):
                calls.append((self.command, self.path, self.headers.get("Authorization")))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "automation": {"id": helper.AUTOMATION_ID, "enabled": False, "template": TOKEN}
                }).encode())

            do_GET = respond
            do_POST = respond

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp, patch.object(helper, "ROOT", Path(tmp)), patch.dict(
                helper.os.environ, {"HAPPIER_HOME_DIR": tmp, "HAPPIER_ACTIVE_SERVER_ID": helper.SERVER_ID}
            ), patch.object(helper, "SERVER_URL", f"http://127.0.0.1:{server.server_port}"), patch.object(
                helper.queue_source, "queue_has_work", return_value=False
            ) as queue:
                registry = self.make_repo(tmp)
                self.claim(registry, "issue-1", "mine")
                state = registry.read()
                auth = Path(tmp) / "servers" / helper.SERVER_ID / "access.key"
                auth.parent.mkdir(parents=True)
                auth.write_text(json.dumps({"token": TOKEN, "encryption": None}))
                code, result = self.cli("--owner", "mine", "--task", "issue-1")
                self.assertEqual(code, 0)
                self.assertEqual(result, {"ok": True, "id": helper.AUTOMATION_ID, "enabled": False,
                                          "action": "pause"})
                # A repeated command reuses this claim's receipt: no second POST, no queue read.
                queue.reset_mock()
                again_code, again_result = self.cli("--owner", "mine", "--task", "issue-1")
                self.assertEqual((again_code, again_result), (code, result))
                queue.assert_not_called()
                # The helper never mutates task claims.
                self.assertEqual(registry.read()["tasks"], state["tasks"])
                receipt = json.loads((registry.directory / helper.RECEIPT_NAME).read_text())
                self.assertEqual(receipt["task"], "issue-1")
                self.assertNotIn(TOKEN, json.dumps(receipt))
            self.assertEqual(calls, [
                ("POST", f"/v2/automations/{helper.AUTOMATION_ID}/pause", f"Bearer {TOKEN}"),
                ("GET", f"/v2/automations/{helper.AUTOMATION_ID}", f"Bearer {TOKEN}"),
            ])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_registry_flock_is_not_held_during_http(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(helper, "ROOT", Path(tmp)), patch.object(
            helper, "load_token", return_value=TOKEN
        ), patch.object(helper.queue_source, "queue_has_work", return_value=False):
            registry = self.make_repo(tmp)
            self.claim(registry, "issue-1", "mine")
            observed = []

            def fake_pause(token, opener):
                with registry.lock_path.open("a+") as lock:
                    try:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        fcntl.flock(lock, fcntl.LOCK_UN)
                        observed.append("free")
                    except BlockingIOError:
                        observed.append("held")
                return {"ok": True, "id": helper.AUTOMATION_ID, "enabled": False}

            with patch.object(helper, "pause", side_effect=fake_pause):
                self.assertTrue(helper.pause_if_idle("mine", "issue-1")["ok"])
            self.assertEqual(observed, ["free"])

    def test_failed_or_interrupted_attempt_is_not_retried_for_same_claim(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(helper, "ROOT", Path(tmp)), patch.object(
            helper, "load_token", return_value=TOKEN
        ), patch.object(helper.queue_source, "queue_has_work", return_value=False), patch.object(
            helper.urllib.request, "build_opener"
        ) as build:
            registry = self.make_repo(tmp)
            self.claim(registry, "issue-1", "mine")
            build.return_value.open.side_effect = urllib.error.HTTPError("http://localhost", 401, TOKEN, {}, None)
            first = helper.pause_if_idle("mine", "issue-1")
            second = helper.pause_if_idle("mine", "issue-1")
            self.assertEqual(first["error"], "http_401")
            self.assertEqual(second["error"], "previous_pause_attempt_failed")
            self.assertEqual(build.return_value.open.call_count, 1)
            self.assertNotIn(TOKEN, json.dumps(second))
            # A process may die after writing "pending", before recording HTTP's result.
            self.claim(registry, "issue-1", "mine")  # new claim => new identity
            acquired = registry.read()["tasks"]["issue-1"]["acquired_at"]
            receipt = {"id": helper.AUTOMATION_ID, "owner": "mine", "task": "issue-1", "acquired_at": acquired,
                       "result": {"ok": False, "error": "pause_attempt_incomplete", "phase": "pause"}}
            (registry.directory / helper.RECEIPT_NAME).write_text(json.dumps(receipt))
            build.reset_mock()
            interrupted = helper.pause_if_idle("mine", "issue-1")
            self.assertFalse(interrupted["ok"])
            self.assertEqual(interrupted["error"], "previous_pause_attempt_failed")
            build.assert_not_called()

    def test_registry_rejects_foreign_expired_worker_or_other_claims_before_http(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(helper, "ROOT", Path(tmp)), patch.object(
            helper, "load_token"
        ) as auth, patch.object(helper.queue_source, "queue_has_work", return_value=False) as queue, patch.object(
            helper.urllib.request, "build_opener"
        ) as build:
            registry = self.make_repo(tmp)
            cases = (
                ({}, "no_task_claim"),
                ({"owner": "foreign"}, "task_owner_mismatch"),
                ({"seconds": 1}, "task_claim_expired_or_too_short"),
                ({"runs": ["worker"]}, "worker_runs_recorded"),
                ({"other": True}, "other_task_claims_active"),
            )
            for kwargs, expected in cases:
                with self.subTest(expected=expected):
                    registry.transaction(lambda state: state["tasks"].clear())
                    if kwargs:
                        self.claim(registry, "issue-1", kwargs.get("owner", "mine"),
                                   seconds=kwargs.get("seconds", 1200), runs=kwargs.get("runs", ()))
                    if kwargs.get("other"):
                        # Another session's claim, even expired, blocks the pause.
                        self.claim(registry, "issue-2", "someone-else", seconds=1)
                    with self.assertRaisesRegex(helper.PauseError, f"^{expected}$"):
                        helper.pause_if_idle("mine", "issue-1")
            # Without an own task, any claim at all blocks the pause.
            with self.assertRaisesRegex(helper.PauseError, "^task_claims_active$"):
                helper.pause_if_idle("mine", None)
            auth.assert_not_called()
            queue.assert_not_called()
            build.assert_not_called()
            # Malformed registry state fails closed.
            registry.state_path.write_text('{"version": 2}')
            with self.assertRaisesRegex(helper.PauseError, "^invalid_coordination$"):
                helper.pause_if_idle("mine", "issue-1")

    def test_pause_without_own_task_requires_empty_registry(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(helper, "ROOT", Path(tmp)), patch.object(
            helper, "load_token", return_value=TOKEN
        ), patch.object(helper.queue_source, "queue_has_work", return_value=False), patch.object(
            helper, "pause", return_value={"ok": True, "id": helper.AUTOMATION_ID, "enabled": False}
        ) as pause:
            registry = self.make_repo(tmp)
            self.assertTrue(helper.pause_if_idle("dispatcher-run-1", None)["ok"])
            # No task claim => no claim identity: a success is never replayed, because
            # the owner may have resumed the schedule since (reused owner name).
            self.assertTrue(helper.pause_if_idle("dispatcher-run-1", None)["ok"])
            self.assertEqual(pause.call_count, 2)
            # Failed or interrupted attempts are still not retried blindly.
            receipt = {"id": helper.AUTOMATION_ID, "owner": "dispatcher-run-1", "task": None,
                       "acquired_at": None,
                       "result": {"ok": False, "error": "pause_attempt_incomplete", "phase": "pause"}}
            (registry.directory / helper.RECEIPT_NAME).write_text(json.dumps(receipt))
            result = helper.pause_if_idle("dispatcher-run-1", None)
            self.assertEqual(result["error"], "previous_pause_attempt_failed")
            self.assertEqual(pause.call_count, 2)

    def test_finalize_manual_run_never_pauses_and_metadata_must_match(self):
        with patch.object(helper, "pause_if_idle") as inner:
            with patch.dict(helper.os.environ, {}, clear=True):
                self.assertEqual(helper.finalize("mine", "issue-1"),
                                 {"ok": True, "action": "none", "reason": "manual_run"})
            for env in ({"SCREEPS_AUTOMATION_ORIGIN": "scheduled", "SCREEPS_AUTOMATION_ID": "foreign"},
                        {"SCREEPS_AUTOMATION_ORIGIN": "manual", "SCREEPS_AUTOMATION_ID": helper.AUTOMATION_ID},
                        {"SCREEPS_AUTOMATION_ORIGIN": "scheduled"}):
                with patch.dict(helper.os.environ, env, clear=True):
                    with self.assertRaisesRegex(helper.PauseError, "^scheduled_origin_mismatch$"):
                        helper.finalize("mine", "issue-1")
            inner.assert_not_called()

    def test_finalize_continues_on_work_and_never_pauses_on_queue_error(self):
        env = {"SCREEPS_AUTOMATION_ORIGIN": "scheduled", "SCREEPS_AUTOMATION_ID": helper.AUTOMATION_ID}
        with tempfile.TemporaryDirectory() as tmp, patch.object(helper, "ROOT", Path(tmp)), patch.dict(
            helper.os.environ, env, clear=True
        ), patch.object(helper, "pause") as pause, patch.object(helper, "load_token", return_value=TOKEN):
            registry = self.make_repo(tmp)
            self.claim(registry, "issue-1", "mine")
            with patch.object(helper.queue_source, "queue_has_work", return_value=True):
                code, result = self.cli("--finalize", "--owner", "mine", "--task", "issue-1")
            self.assertEqual((code, result), (0, {"ok": True, "action": "continue", "reason": "remaining_work"}))
            with patch.object(helper.queue_source, "queue_has_work",
                              side_effect=helper.queue_source.QueueError("gh_failed")):
                code, result = self.cli("--finalize", "--owner", "mine", "--task", "issue-1")
            self.assertEqual(code, 1)
            self.assertEqual(result["error"], "gh_failed")
            pause.assert_not_called()
            self.assertFalse((registry.directory / helper.RECEIPT_NAME).exists())
            # Finalization never touches the claim: finish still works afterwards.
            self.assertIn("issue-1", registry.read()["tasks"])

    def test_missing_owner_does_not_read_auth_and_unexpected_errors_are_sanitized(self):
        with patch.object(helper, "load_token") as auth:
            code, result = self.cli()
            self.assertEqual(code, 1)
            self.assertEqual(result["error"], "owner_required")
            auth.assert_not_called()
        with patch.object(helper, "load_token", side_effect=RuntimeError(TOKEN)):
            code, result = self.cli("--check")
            self.assertEqual(code, 1)
            self.assertEqual(result["error"], "unexpected_error")


class DisabledConfigurationTest(unittest.TestCase):
    def test_unconfigured_helper_fails_before_network_or_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = dict(__import__('os').environ, HOME=tmp)
            result = subprocess.run(
                [__import__('sys').executable, str(Path(helper.__file__)), '--check'],
                env=env, capture_output=True, text=True, check=False,
            )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)['error'], 'automation_not_configured')


if __name__ == "__main__":
    unittest.main()
