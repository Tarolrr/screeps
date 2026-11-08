#!/usr/bin/env python3
"""Pause this project's Happier automation and verify it, without exposing auth.

Task-lease protocol (ADR 0002). A scheduled run may pause the project automation
only when the GitHub queue has no ready/in-progress/review work AND the
autonomyctl v2 registry has no task claims other than the caller's own claim,
which must be live and have no recorded runs. The registry flock is held only
for short local transitions (check + receipt write), never during HTTP or
queue reads. The helper does not change task or resource claims, but it does
write its receipt file inside registry transactions (which also rewrite
state.json unchanged). A durable receipt per (automation, owner, task claim)
prevents a repeated POST. This helper never claims, recovers, heartbeats or
finishes a task; `autonomyctl.py finish` runs afterwards regardless of the
result here.
"""
import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import urllib.error
import urllib.request

import autonomyctl
import queue_source


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
RECEIPT_NAME = "automation-pause-result.json"
RESULT_KEYS = {"ok", "id", "enabled", "error", "phase", "pause_accepted"}


class PauseError(Exception):
    """Only fixed, non-secret error codes belong in this exception."""


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise PauseError("invalid_arguments")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward the Authorization header to a redirected endpoint.
        return None


def configured():
    return all((AUTOMATION_ID, SERVER_ID, SERVER_URL))


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


def save_json(path, value):
    fd, tmp = tempfile.mkstemp(prefix="receipt-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(value, output, ensure_ascii=False, allow_nan=False)
            output.flush()
            os.fsync(output.fileno())
        os.replace(tmp, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def load_token():
    if not configured():
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


def verify_registry(state, owner, task):
    """Return the receipt identity if the registry allows a pause; raise otherwise.

    Expired claims of other tasks still count: expiry never proves a writer stopped.
    """
    if not owner:
        raise PauseError("owner_required")
    tasks = state["tasks"]
    if task is None:
        if tasks:
            raise PauseError("task_claims_active")
        return {"id": AUTOMATION_ID, "owner": owner, "task": None, "acquired_at": None}
    claim = tasks.get(task)
    if claim is None:
        raise PauseError("no_task_claim")
    if claim["owner"] != owner:
        raise PauseError("task_owner_mismatch")
    if not time.time() + 2 * TIMEOUT + 5 < claim["expires_at"]:
        raise PauseError("task_claim_expired_or_too_short")
    if claim["runs"]:
        raise PauseError("worker_runs_recorded")
    if any(other != task for other in tasks):
        raise PauseError("other_task_claims_active")
    return {"id": AUTOMATION_ID, "owner": owner, "task": task, "acquired_at": claim["acquired_at"]}


def stored_result(directory, identity):
    """Previous result for this identity, sanitized; None when no matching receipt."""
    receipt_file = directory / RECEIPT_NAME
    if not receipt_file.exists():
        return None
    old = read_json(receipt_file)
    if any(old.get(k) != v for k, v in identity.items()):
        return None
    result = old.get("result")
    if (not isinstance(result, dict) or type(result.get("ok")) is not bool
            or set(result) - RESULT_KEYS):
        raise PauseError("invalid_pause_receipt")
    if result["ok"]:
        if result.get("id") != AUTOMATION_ID or result.get("enabled") is not False:
            raise PauseError("invalid_pause_receipt")
        if identity["task"] is None:
            # Without a task claim the key is only (automation, owner). An owner
            # reused after the owner resumed the schedule must not replay an old
            # success; pending/failed receipts still block a blind retry.
            return None
        return {"ok": True, "id": AUTOMATION_ID, "enabled": False}
    # The file is local input too; do not echo arbitrary error text.
    old_phase = result.get("phase")
    safe_phase = old_phase if old_phase in {"setup", "pause", "verify"} else "pause"
    return {"ok": False, "error": "previous_pause_attempt_failed", "phase": safe_phase,
            "pause_accepted": result.get("pause_accepted") is True}


def open_registry():
    try:
        return autonomyctl.Registry(ROOT)
    except (autonomyctl.CoordinationError, OSError):
        raise PauseError("coordination_unavailable") from None


def read_registry(registry):
    try:
        return registry.read()
    except (autonomyctl.CoordinationError, OSError):
        raise PauseError("invalid_coordination") from None


def reserve_attempt(registry, owner, task):
    """One atomic transition: recheck the registry and the receipt, then record a
    pending attempt BEFORE any HTTP so that a crash or lost response is never retried."""
    def op(state):
        identity = verify_registry(state, owner, task)
        previous = stored_result(registry.directory, identity)
        if previous is not None:
            return identity, previous
        pending = {"ok": False, "error": "pause_attempt_incomplete", "phase": "pause"}
        save_json(registry.directory / RECEIPT_NAME, {**identity, "result": pending})
        return identity, None
    try:
        return registry.transaction(op)
    except (autonomyctl.CoordinationError, OSError):
        raise PauseError("invalid_coordination") from None


def record_result(registry, identity, result):
    def op(state):
        save_json(registry.directory / RECEIPT_NAME, {**identity, "result": result})
    try:
        registry.transaction(op)
    except (autonomyctl.CoordinationError, OSError):
        return {"ok": False, "error": "pause_receipt_write_failed", "phase": result.get("phase", "pause")}
    return result


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


def pause_if_idle(owner, task, remaining_work_is_error=True):
    """Shared path for the explicit pause and scheduled finalization."""
    if not configured():
        raise PauseError("automation_not_configured")
    if not owner:
        raise PauseError("owner_required")
    registry = open_registry()
    # Cheap local precheck first: a repeated call returns its receipt without
    # reading credentials or the network.
    identity = verify_registry(read_registry(registry), owner, task)
    previous = stored_result(registry.directory, identity)
    if previous is not None:
        return {"action": "pause", **previous}
    try:
        has_work = queue_source.queue_has_work(ROOT)
    except queue_source.QueueError as exc:
        # Access/data failure is not an empty queue: never pause on it.
        raise PauseError(str(exc)) from None
    if has_work:
        if remaining_work_is_error:
            raise PauseError("queue_has_work")
        return {"ok": True, "action": "continue", "reason": "remaining_work"}
    token = load_token()
    identity, previous = reserve_attempt(registry, owner, task)
    if previous is not None:
        return {"action": "pause", **previous}
    phase = "pause"
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        result = pause(token, opener)
    except PauseError as exc:
        result = {"ok": False, "error": str(exc), "phase": phase}
    except Exception:
        result = {"ok": False, "error": "unexpected_error", "phase": phase}
    return {"action": "pause", **record_result(registry, identity, result)}


def finalize(owner, task):
    """Scheduled-run finalization, driven by run metadata. A manual run (no metadata)
    never pauses. Call before `autonomyctl.py finish`; failure never blocks finishing."""
    origin = os.environ.get("SCREEPS_AUTOMATION_ORIGIN")
    automation_id = os.environ.get("SCREEPS_AUTOMATION_ID")
    if origin is None and automation_id is None:
        return {"ok": True, "action": "none", "reason": "manual_run"}
    if not configured():
        raise PauseError("automation_not_configured")
    if origin != "scheduled" or automation_id != AUTOMATION_ID:
        raise PauseError("scheduled_origin_mismatch")
    return pause_if_idle(owner, task, remaining_work_is_error=False)


def main(argv=None):
    phase = "setup"
    try:
        parser = Parser(description=__doc__)
        mode = parser.add_mutually_exclusive_group()
        mode.add_argument("--check", action="store_true", help="validate local auth only; no HTTP or mutation")
        mode.add_argument("--finalize", action="store_true",
                          help="scheduled-run finalization from SCREEPS_AUTOMATION_* metadata")
        parser.add_argument("--owner", help="caller's autonomyctl owner (required to pause)")
        parser.add_argument("--task", help="caller's own autonomyctl task claim, if any")
        parser.add_argument("--automation-id", default=AUTOMATION_ID,
                            help="must match this project's ID, including when supplied by run metadata")
        args = parser.parse_args(argv)
        if args.finalize:
            result = finalize(args.owner, args.task)
        else:
            if not configured():
                raise PauseError("automation_not_configured")
            if args.automation_id != AUTOMATION_ID:
                raise PauseError("automation_id_mismatch")
            if args.check:
                load_token()
                result = {"ok": True, "id": AUTOMATION_ID, "mode": "check", "network": False}
            else:
                result = pause_if_idle(args.owner, args.task)
    except PauseError as exc:
        result = {"ok": False, "error": str(exc), "phase": phase}
    except Exception:
        # Provider/server exceptions can contain auth. Never print their text.
        result = {"ok": False, "error": "unexpected_error", "phase": phase}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
