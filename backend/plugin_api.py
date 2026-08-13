"""simtest desktop plugin backend.

Controls an iOS Simulator + serve-sim via the `simtest` script
(on/off/status). Mounted by the Hermes desktop app under
/api/plugins/simtest/ when the plugin is listed in `plugins.enabled` in
config.yaml.

Configuration (env vars, all optional):
  SIMTEST_UDID          — simulator device UDID (default: first available iPhone)
  SIMTEST_PORT          — serve-sim port (default: 3200)
  SIMTEST_SCRIPT        — path to the simtest script (default: ~/.local/bin/simtest)
  SIMTEST_DEVELOPER_DIR — DEVELOPER_DIR for the Xcode toolchain (default: system)

Security: all commands are fixed constants; no user input ever reaches a
shell. subprocess is always called with a list (no shell=True).
"""

import os
import re
import subprocess
import urllib.request

from fastapi import APIRouter, Depends, HTTPException, Request

# Local-only guard: reject non-local Hosts and foreign Origins (CSRF).
# Non-browser callers (curl, gateway probes) send no Origin → allowed.
_ALLOWED_ORIGIN_PREFIXES = ("http://localhost", "http://127.0.0.1", "file://", "app://", "null")


async def _local_only(request: Request) -> None:
    hostname = (request.headers.get("host", "") or "").split(":")[0]
    if hostname not in ("localhost", "127.0.0.1", ""):
        raise HTTPException(status_code=403, detail="forbidden host")
    origin = request.headers.get("origin")
    if origin and not origin.startswith(_ALLOWED_ORIGIN_PREFIXES):
        raise HTTPException(status_code=403, detail="forbidden origin")


router = APIRouter(dependencies=[Depends(_local_only)])

SIMTEST = os.environ.get("SIMTEST_SCRIPT", os.path.expanduser("~/.local/bin/simtest"))
PORT = os.environ.get("SIMTEST_PORT", "3200")
SERVE_SIM_URL = f"http://localhost:{PORT}/"
# Match the simtest script's PIDFILE logic: TMPDIR on macOS is a per-user
# randomized path (/var/folders/...), so both sides must resolve it the same way.
PIDFILE = os.path.join(os.environ.get("TMPDIR", "/tmp"), "serve-sim.pid")
RUN_TIMEOUT = 90  # seconds — bootstatus + first npx install can exceed 30s

_UDID_RE = re.compile(r"[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}")

# Match the simtest script's environment so xcrun finds the right toolchain.
_PROC_ENV = dict(os.environ)
_PROC_ENV["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin:" + _PROC_ENV.get("PATH", "")
if os.environ.get("SIMTEST_DEVELOPER_DIR"):
    _PROC_ENV["DEVELOPER_DIR"] = os.environ["SIMTEST_DEVELOPER_DIR"]


def _first_iphone_udid() -> str | None:
    """UDID of the first available iPhone simulator, or None."""
    try:
        proc = subprocess.run(
            ["xcrun", "simctl", "list", "devices", "available"],
            capture_output=True,
            text=True,
            timeout=10,
            env=_PROC_ENV,
        )
    except Exception:
        return None
    for line in proc.stdout.splitlines():
        if "iPhone" not in line:
            continue
        match = _UDID_RE.search(line)
        if match:
            return match.group(0)
    return None


def _udid() -> str | None:
    """Configured UDID (SIMTEST_UDID) or auto-detected first iPhone."""
    return os.environ.get("SIMTEST_UDID") or _first_iphone_udid()


def _sim_booted() -> bool:
    """True when the target simulator device is Booted."""
    udid = _udid()
    if not udid:
        return False
    try:
        proc = subprocess.run(
            ["xcrun", "simctl", "list", "devices"],
            capture_output=True,
            text=True,
            timeout=10,
            env=_PROC_ENV,
        )
    except Exception:
        return False
    for line in proc.stdout.splitlines():
        if udid in line and "Booted" in line:
            return True
    return False


def _serve_sim() -> bool:
    """True when serve-sim answers HTTP 200 on localhost:<port>."""
    try:
        with urllib.request.urlopen(SERVE_SIM_URL, timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False


def _serve_sim_pid():
    """PID from the serve-sim pidfile if that process is alive, else None."""
    try:
        with open(PIDFILE, "r", encoding="utf-8") as f:
            pid = int(f.read().strip())
    except Exception:
        return None
    if pid <= 0:
        return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return None
    except PermissionError:
        pass  # exists, owned by someone else
    return pid


@router.get("/status")
def status():
    """Current sim + serve-sim state. Fixed commands, no user input."""
    return {
        "sim_booted": _sim_booted(),
        "serve_sim": _serve_sim(),
        "pid": _serve_sim_pid(),
    }


def _run_simtest(action: str) -> dict:
    """Run `simtest on|off`, return raw output + exit code."""
    try:
        proc = subprocess.run(
            [SIMTEST, action],
            capture_output=True,
            text=True,
            timeout=RUN_TIMEOUT,
            env=_PROC_ENV,
        )
    except subprocess.TimeoutExpired:
        # Best-effort cleanup of any orphaned serve-sim listener before reporting.
        _cleanup_orphans()
        return {"ok": False, "exit_code": -1, "output": "timeout (90s)"}
    except Exception as exc:  # noqa: BLE001 — surface raw error, don't translate
        return {"ok": False, "exit_code": -1, "output": str(exc)}
    output = (proc.stdout + "\n" + proc.stderr).strip()
    return {"ok": proc.returncode == 0, "exit_code": proc.returncode, "output": output}


def _cleanup_orphans() -> None:
    """Kill any orphaned serve-sim listener on the configured port."""
    try:
        result = subprocess.run(
            ["lsof", "-tiTCP:" + PORT, "-sTCP:LISTEN"],
            capture_output=True,
            text=True,
            timeout=5,
            env=_PROC_ENV,
        )
        for line in result.stdout.splitlines():
            pid = int(line.strip())
            if pid > 0:
                os.kill(pid, 15)  # SIGTERM
    except Exception:
        pass  # best-effort


@router.post("/on")
def sim_on():
    """Boot sim + start serve-sim."""
    return _run_simtest("on")


@router.post("/off")
def sim_off():
    """Stop serve-sim (sim stays booted)."""
    return _run_simtest("off")
