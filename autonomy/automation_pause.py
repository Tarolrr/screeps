#!/usr/bin/env python3
"""Pause this project's Happier automation and verify it, without exposing auth."""
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request

import queue_source
from coordination import validate as validate_coordination
from coordination import save as save_json


# Configuration is external to the checkout and disabled unless explicitly provisioned.
CONFIG_PATH = Path.home() / ".config" / "screeps-strategy" / "automation.json"
AUTOMATION_ID = SERVER_ID = SERVER_URL = None
try:
    config = json.loads(CONFIG_PATH.read_text())
    from urllib.parse import urlparse
    url = urlparse(config.get("server_url", ""))
    if (config.get("enabled") is True and isinstance(config.get("automation_id"), str)
            and config["automation_id"].isalnum() and isinstance(config.get("server_id"), str)
            and config["server_id"] and all(c.isalnum() or c in "._-" for c in config["server_id"])
            and url.scheme in ("http", "https") and url.hostname in ("localhost", "127.0.0.1", "::1")
            and not url.username and not url.password and not url.path.strip("/") and not url.query and not url.fragment):
        AUTOMATION_ID, SERVER_ID, SERVER_URL = config["automation_id"], config["server_id"], config["server_url"].rstrip("/")
except (OSError, ValueError, TypeError, AttributeError):
    pass
ROOT = Path(__file__).resolve().parent.parent
TIMEOUT = 15
MAX_JSON_BYTES = 65536


class PauseError(Exception):
    """Only fixed, non-secret error codes belong in this exception."""


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise PauseError("invalid_arguments")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward the Authorization header to a redirected endpoint.
        return None


def read_json(path):
    try:
        with path.open("rb") as source:
            raw = source.read(MAX_JSON_BYTES + 1)
        if len(raw) > MAX_JSON_BYTES:
            raise ValueError
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError
        return result
    except (OSError, ValueError, UnicodeError):
        raise PauseError("invalid_local_json") from None


def load_token():
    if not all((AUTOMATION_ID, SERVER_ID, SERVER_URL)):
        raise PauseError("automation_not_configured")
    selected = os.environ.get("HAPPIER_ACTIVE_SERVER_ID")
    if selected and selected != SERVER_ID:
        raise PauseError("server_id_mismatch")
    home = Path(os.environ.get("HAPPIER_HOME_DIR") or Path.home() / ".happier").expanduser()
    # Same JSON {token, ...} file format as Happier CLI readCredentials().
    credentials = read_json(home / "servers" / SERVER_ID / "access.key")
    token = credentials.get("token")
    if (not isinstance(token, str) or not token or not token.isascii()
            or not token.isprintable() or any(c.isspace() for c in token)):
        raise PauseError("invalid_credentials")
    return token


def verify_lease(active, owner):
    if not owner:
        raise PauseError("owner_required")
    if not isinstance(active, dict):
        raise PauseError("no_coordinator_lease")
    if active.get("owner") != owner:
        raise PauseError("lease_owner_mismatch")
    expiry = active.get("expires_at")
    if type(expiry) not in (int, float) or not time.time() + 2 * TIMEOUT + 5 < expiry < 1e20:
        raise PauseError("lease_expired_or_too_short")
    if active.get("runs") != []:
        raise PauseError("worker_runs_recorded")


@contextmanager
def coordinator_guard(owner):
    """Check the existing lease; never acquire, recover, or release it here."""
    if not owner:
        raise PauseError("owner_required")
    try:
        common = subprocess.check_output(
            ["git", "-C", str(ROOT), "rev-parse", "--path-format=absolute", "--git-common-dir"],
            text=True, stderr=subprocess.DEVNULL,
        ).strip()
        directory = Path(common) / "autonomy-coordination"
        with (directory / "control.lock").open("r+") as control:
            try:
                fcntl.flock(control, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise PauseError("coordination_busy") from None
            if (directory / "initialized").read_text() != "coordination-v1\n":
                raise PauseError("invalid_coordination")
            state = read_json(directory / "state.json")
            try:
                validate_coordination(state)
            except ValueError:
                raise PauseError("invalid_coordination") from None
            active = state.get("active")
            verify_lease(active, owner)
            yield active, directory
    except (OSError, subprocess.CalledProcessError):
        raise PauseError("coordination_unavailable") from None


def request(opener, token, method, suffix=""):
    req = urllib.request.Request(
        f"{SERVER_URL}/v2/automations/{AUTOMATION_ID}{suffix}",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        method=method,
    )
    try:
        with opener.open(req, timeout=TIMEOUT) as response:
            if not 200 <= response.status < 300:
                raise PauseError("unexpected_http_status")
            if method == "POST":
                return None
            raw = response.read(MAX_JSON_BYTES + 1)
        if len(raw) > MAX_JSON_BYTES:
            raise PauseError("readback_too_large")
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError
        return result
    except urllib.error.HTTPError as exc:
        # Do not expose response bodies, URL errors, or credential-bearing text.
        raise PauseError(f"http_{exc.code}") from None
    except (OSError, urllib.error.URLError, ValueError, UnicodeError):
        raise PauseError("request_failed") from None


def pause(token, opener):
    request(opener, token, "POST", "/pause")
    try:
        result = request(opener, token, "GET")
        # Some Happier API versions wrap the automation in an envelope.
        automation = result.get("automation", result)
        if (not isinstance(automation, dict) or automation.get("id") != AUTOMATION_ID
                or automation.get("enabled") is not False):
            raise PauseError("pause_not_confirmed")
    except PauseError as exc:
        return {"ok": False, "error": str(exc), "phase": "verify", "pause_accepted": True}
    return {"ok": True, "id": AUTOMATION_ID, "enabled": False}


def finalize_under_lock(active, owner, directory):
    """Caller holds coordination flock. A durable receipt prevents a second POST."""
    phase = "setup"
    if not all((AUTOMATION_ID, SERVER_ID, SERVER_URL)):
        return {"ok": False, "error": "automation_not_configured", "phase": phase}
    receipt_file = directory / "automation-pause-result.json"
    identity = {"owner": owner, "acquired_at": active["acquired_at"], "id": AUTOMATION_ID}
    try:
        if os.environ.get("SCREEPS_AUTOMATION_ID", AUTOMATION_ID) != AUTOMATION_ID:
            raise PauseError("automation_id_mismatch")
        if receipt_file.exists():
            old = read_json(receipt_file)
            if all(old.get(k) == v for k, v in identity.items()):
                result = old.get("result")
                if (not isinstance(result, dict) or type(result.get("ok")) is not bool
                        or set(result) - {"ok", "id", "enabled", "error", "phase", "pause_accepted"}):
                    raise PauseError("invalid_pause_receipt")
                if result["ok"]:
                    if result.get("id") != AUTOMATION_ID or result.get("enabled") is not False:
                        raise PauseError("invalid_pause_receipt")
                    return {"ok": True, "id": AUTOMATION_ID, "enabled": False}
                # The file is local input too; do not echo arbitrary error text.
                old_phase = result.get("phase")
                safe_phase = old_phase if old_phase in {"setup", "pause", "verify"} else "pause"
                return {"ok": False, "error": "previous_pause_attempt_failed", "phase": safe_phase,
                        "pause_accepted": result.get("pause_accepted") is True}
        verify_lease(active, owner)
        token = load_token()
        # Record the attempt BEFORE HTTP: a crash or lost response must not retry it.
        pending = {"ok": False, "error": "pause_attempt_incomplete", "phase": "pause"}
        save_json(receipt_file, {**identity, "result": pending})
        phase = "pause"
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        result = pause(token, opener)
    except PauseError as exc:
        result = {"ok": False, "error": str(exc), "phase": phase}
    except Exception:
        result = {"ok": False, "error": "unexpected_error", "phase": phase}
    try:
        save_json(receipt_file, {**identity, "result": result})
    except OSError:
        return {"ok": False, "error": "pause_receipt_write_failed", "phase": phase}
    return result


def main(argv=None):
    phase = "setup"
    try:
        parser = Parser(description=__doc__)
        parser.add_argument("--owner", help="current coordinator lease owner (required to pause)")
        parser.add_argument("--automation-id", default=AUTOMATION_ID,
                            help="must match this project's ID, including when supplied by run metadata")
        parser.add_argument("--check", action="store_true", help="validate local auth only; no HTTP or mutation")
        args = parser.parse_args(argv)
        if not all((AUTOMATION_ID, SERVER_ID, SERVER_URL)):
            raise PauseError("automation_not_configured")
        if args.automation_id != AUTOMATION_ID:
            raise PauseError("automation_id_mismatch")
        if args.check:
            load_token()
            result = {"ok": True, "id": AUTOMATION_ID, "mode": "check", "network": False}
        else:
            with coordinator_guard(args.owner) as (active, directory):
                try:
                    if queue_source.queue_has_work(ROOT):
                        raise PauseError("queue_has_work")
                except queue_source.QueueError as exc:
                    raise PauseError(str(exc)) from None
                result = finalize_under_lock(active, args.owner, directory)
    except PauseError as exc:
        result = {"ok": False, "error": str(exc), "phase": phase}
    except Exception:
        # Provider/server exceptions can contain auth. Never print their text.
        result = {"ok": False, "error": "unexpected_error", "phase": phase}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
