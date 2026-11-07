"""Capture generated designs as pixels in a fresh, network-blocked browser.

Vercel uses a disposable microVM: pinned browser packages are installed while
only npm's registry is reachable, then egress is denied before source arrives.
Locally, a clean-environment Node process controls installed Chrome/Chromium.
"""

import asyncio
import base64
import hashlib
import json
import os
import re
import shutil
import signal
import struct
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Literal

from vercel import sandbox as sdk
from vercel.oidc.credentials import get_credentials
from vercel.sandbox import NetworkPolicy, SandboxResources

PACKAGE_DIR = Path(__file__).parent
RUNTIME_DIR = PACKAGE_DIR / "screenshot"
RUNNER = PACKAGE_DIR / "render_preview.cjs"
ARTIFACTS = PACKAGE_DIR / "web" / "artifacts.js"
MAX_SOURCE_CHARS = 100_000
MAX_PNG_BYTES = 524_288
MAX_BATCH_URL_CHARS = 2_800_000
MAX_OUTPUT_BYTES = 3_100_000
CAPTURE_TIMEOUT = 180
_install_lock = asyncio.Lock()
_SDK_FAILURES = (sdk.SandboxError, OSError, RuntimeError, ValueError, TimeoutError)


class RenderingError(RuntimeError):
    """A bounded, public-safe setup or capture failure."""


def _remote() -> bool:
    selected = os.environ.get("EVALGEN_SCREENSHOT_BACKEND")
    return selected == "vercel" or selected != "local" and bool(os.environ.get("VERCEL"))


def _browser_path() -> str | None:
    configured = os.environ.get("EVALGEN_CHROMIUM_EXECUTABLE")
    candidates: list[str | None] = [configured] if configured else []
    candidates.extend(
        [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            shutil.which("chromium"),
            shutil.which("chromium-browser"),
            shutil.which("google-chrome"),
            shutil.which("google-chrome-stable"),
        ]
    )
    return next((path for path in candidates if path and os.access(path, os.X_OK)), None)


def renderer_status() -> dict[str, bool | str | None]:
    """Check prerequisites without launching a browser or billing for a VM."""
    if _remote():
        try:
            get_credentials()
        except _SDK_FAILURES:
            return {
                "available": False,
                "backend": "vercel",
                "reason": "Screenshot capture requires Vercel project OIDC credentials.",
            }
        return {
            "available": True,
            "backend": "vercel",
            "reason": "Isolated Vercel browser; initial 960 × 640 viewport, up to 2000 px tall.",
        }
    node = shutil.which("node")
    if not node or not shutil.which("npm") or not _compatible_node(node):
        return {
            "available": False,
            "backend": "local",
            "reason": "Screenshot capture needs Node.js 22.17 or newer and npm.",
        }
    if not _browser_path():
        return {
            "available": False,
            "backend": "local",
            "reason": "Install Chrome/Chromium or set EVALGEN_CHROMIUM_EXECUTABLE for screenshots.",
        }
    return {
        "available": True,
        "backend": "local",
        "reason": "Local isolated browser; initial 960 × 640 viewport, up to 2000 px tall.",
    }


def _compatible_node(node: str) -> bool:
    try:
        result = subprocess.run(
            [node, "--version"], capture_output=True, text=True, timeout=3,
            env={"PATH": os.defpath}, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    match = re.match(r"v?(\d+)\.(\d+)", result.stdout.strip())
    if result.returncode != 0 or not match:
        return False
    major, minor = map(int, match.groups())
    return major > 22 or major == 22 and minor >= 17


def _clean_env(home: Path, **extra: str) -> dict[str, str]:
    return {
        "PATH": os.defpath + ":/usr/local/bin:/opt/homebrew/bin",
        "HOME": str(home),
        "LANG": "C.UTF-8",
        "TMPDIR": str(home),
        "npm_config_registry": "https://registry.npmjs.org",
        "npm_config_userconfig": str(home / ".npmrc"),
        **extra,
    }


async def _run_local_command(
    command: str,
    args: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    payload: bytes = b"",
    timeout: float,
    max_output: int = MAX_OUTPUT_BYTES,
) -> bytes:
    """Bound all output and kill the browser's process group on cancellation."""
    process = await asyncio.create_subprocess_exec(
        command,
        *args,
        cwd=cwd,
        env=env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=os.name == "posix",
    )

    async def read(stream: asyncio.StreamReader | None, limit: int) -> bytes:
        assert stream is not None
        chunks = []
        used = 0
        while chunk := await stream.read(65_536):
            used += len(chunk)
            if used > limit:
                raise RenderingError("Screenshot process exceeded its output limit.")
            chunks.append(chunk)
        return b"".join(chunks)

    try:
        async with asyncio.timeout(timeout):
            assert process.stdin is not None
            process.stdin.write(payload)
            await process.stdin.drain()
            process.stdin.close()
            stdout, _ = await asyncio.gather(
                read(process.stdout, max_output), read(process.stderr, 16_384)
            )
            if await process.wait() != 0:
                raise RenderingError("Screenshot browser setup or execution failed.")
            return stdout
    finally:
        if process.returncode is None:
            try:
                if os.name == "posix":
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
            except ProcessLookupError:
                pass
            await process.wait()


async def _local_runtime() -> Path:
    """Install the checked-in lockfile outside the source tree, once per version."""
    lock = (RUNTIME_DIR / "package-lock.json").read_bytes()
    digest = hashlib.sha256(lock).hexdigest()[:16]
    cache = Path.home() / ".cache" / "evalgen-renderer"
    target = cache / digest
    marker = target / ".ready"
    async with _install_lock:
        if marker.is_file():
            return target / "node_modules"
        cache.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.TemporaryDirectory(prefix="install-", dir=cache) as temporary:
            staging = Path(temporary)
            for name in ("package.json", "package-lock.json"):
                shutil.copyfile(RUNTIME_DIR / name, staging / name)
            npm = shutil.which("npm")
            if not npm:
                raise RenderingError("Screenshot capture requires npm.")
            await _run_local_command(
                npm,
                ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
                cwd=staging,
                env=_clean_env(staging),
                timeout=90,
                max_output=65_536,
            )
            (staging / ".ready").write_text(digest)
            try:
                staging.rename(target)
            except FileExistsError as error:
                if not marker.is_file():
                    raise RenderingError(
                        "Screenshot runtime installation could not be verified."
                    ) from error
        return target / "node_modules"


async def _capture_local(payload: bytes) -> bytes:
    modules = await _local_runtime()
    browser, node = _browser_path(), shutil.which("node")
    if not browser or not node:
        raise RenderingError("A local Chrome/Chromium browser and Node.js are required.")
    with tempfile.TemporaryDirectory(prefix="evalgen-capture-") as temporary:
        home = Path(temporary)
        return await _run_local_command(
            node,
            ["--max-old-space-size=256", str(RUNNER)],
            cwd=home,
            env=_clean_env(
                home,
                EVALGEN_RENDERER_MODULES=str(modules),
                EVALGEN_ARTIFACT_MODULE=str(ARTIFACTS),
                EVALGEN_CHROMIUM_EXECUTABLE=browser,
            ),
            payload=payload,
            timeout=CAPTURE_TIMEOUT,
        )


async def _capture_remote(payload: bytes) -> bytes:
    """Install trusted packages, deny egress, then upload and render source."""
    options = {
        "name": "evalgen-capture-" + uuid.uuid4().hex,
        "persistent": False,
        "network_policy": NetworkPolicy.custom({"registry.npmjs.org": []}),
        "resources": SandboxResources(vcpus=1, memory=2048),
        "execution_time_limit": 240,
        "ports": [],
        "env": {},
        "mounts": {},
    }
    # SDK context exit stops and destroys the VM and orphan snapshots even when
    # rendering fails or this request is cancelled.
    async with asyncio.timeout(220), sdk.create_sandbox(**options) as box:
        user = await box.create_user("evalgen-renderer")
        home = "/home/evalgen-renderer"
        for name in ("package.json", "package-lock.json"):
            await user.fs.write_text(f"{home}/{name}", (RUNTIME_DIR / name).read_text())
        install = await user.run_command(
            "/usr/bin/env",
            [
                "-i", "PATH=/usr/local/bin:/usr/bin:/bin", f"HOME={home}",
                "npm_config_registry=https://registry.npmjs.org", "npm", "ci",
                "--ignore-scripts", "--no-audit", "--no-fund",
            ],
            cwd=home,
            env={},
            kill_after=90,
            check=False,
        )
        if install.returncode != 0:
            raise RenderingError("Could not prepare the isolated screenshot browser.")
        await box.update_network_policy(NetworkPolicy.deny_all())
        # Generated material is not sent to the VM until the firewall is closed.
        await user.fs.write_text(f"{home}/artifacts.js", ARTIFACTS.read_text())
        await user.fs.write_text(f"{home}/render_preview.cjs", RUNNER.read_text())
        await user.fs.write_bytes(f"{home}/input.json", payload)
        # The output file avoids SDK stdout buffering and is checked before read.
        execution = await user.run_command(
            "/usr/bin/env",
            [
                "-i", "PATH=/usr/local/bin:/usr/bin:/bin", f"HOME={home}", "LANG=C.UTF-8",
                f"EVALGEN_RENDERER_MODULES={home}/node_modules",
                f"EVALGEN_ARTIFACT_MODULE={home}/artifacts.js", "EVALGEN_RENDERER_REMOTE=1",
                "VERCEL=1",
                "EVALGEN_RENDERER_DEBUG=" + (
                    "1" if os.environ.get("EVALGEN_RENDERER_DEBUG") == "1" else "0"
                ),
                "node", "--max-old-space-size=256", "-e",
                "const fs=require('node:fs'), cp=require('node:child_process');"
                "const result=cp.spawnSync(process.execPath,['--max-old-space-size=256',"
                "'render_preview.cjs'],{input:fs.readFileSync('input.json'),"
                "maxBuffer:3100000,timeout:180000,env:process.env});"
                "if(result.status!==0||result.error){"
                "process.stderr.write(result.stderr||String(result.error||'Browser failed'));"
                "process.exit(1);}"
                "fs.writeFileSync('output.json',result.stdout);",
            ],
            cwd=home,
            env={},
            kill_after=CAPTURE_TIMEOUT + 5,
            check=False,
        )
        if execution.returncode != 0:
            raise RenderingError("The isolated screenshot browser could not finish capture.")
        result = await user.fs.read_bytes(f"{home}/output.json")
        if len(result) > MAX_OUTPUT_BYTES:
            raise RenderingError("Screenshot process exceeded its output limit.")
        return result


def _validate_results(raw: bytes, outputs: list[str]) -> list[dict[str, object]]:
    """Do not trust renderer output, even when the runner itself is trusted."""
    try:
        results = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as error:
        raise RenderingError("The screenshot browser returned unreadable results.") from error
    if not isinstance(results, list) or len(results) != len(outputs):
        raise RenderingError("The screenshot browser returned incomplete results.")
    used = 0
    for result, source in zip(results, outputs, strict=True):
        expected = hashlib.sha256(source.encode()).hexdigest()
        if not isinstance(result, dict) or result.get("source_hash") != expected:
            raise RenderingError("The screenshot browser returned mismatched source provenance.")
        if result.get("error"):
            if not isinstance(result["error"], str) or len(result["error"]) > 300:
                raise RenderingError("The screenshot browser returned an invalid capture error.")
            continue
        data_url = result.get("data_url")
        if not isinstance(data_url, str) or not data_url.startswith("data:image/png;base64,"):
            raise RenderingError("The screenshot browser did not return a PNG image.")
        try:
            png = base64.b64decode(data_url.split(",", 1)[1], validate=True)
        except ValueError as error:
            raise RenderingError("The screenshot browser returned an invalid PNG image.") from error
        if len(png) > MAX_PNG_BYTES or len(png) < 24 or png[:8] != b"\x89PNG\r\n\x1a\n":
            raise RenderingError("The screenshot browser returned an invalid or oversized PNG.")
        width, height = struct.unpack(">II", png[16:24])
        if width != 960 or not 640 <= height <= 2000:
            raise RenderingError("The screenshot browser returned an invalid image size.")
        if result.get("width") != width or result.get("height") != height:
            raise RenderingError("Screenshot dimensions do not match the PNG image.")
        if result.get("viewport") != {"width": 960, "height": 640}:
            raise RenderingError("The screenshot browser returned an invalid viewport.")
        used += len(data_url)
        if used > MAX_BATCH_URL_CHARS:
            raise RenderingError("The screenshot batch exceeds its image budget.")
    return results


async def render_previews(
    outputs: list[str], output_format: Literal["svg", "html"]
) -> list[dict[str, object]]:
    """Return pixels or an explicit error for every source, retaining input order."""
    if output_format not in ("svg", "html") or not 1 <= len(outputs) <= 10:
        raise ValueError("Capture requires 1–10 SVG or HTML responses.")
    if any(not isinstance(source, str) or len(source) > MAX_SOURCE_CHARS for source in outputs):
        raise ValueError("Each screenshot source must be at most 100,000 characters.")
    status = renderer_status()
    if not status["available"]:
        raise RenderingError(str(status["reason"]))
    payload = json.dumps(
        {"outputs": outputs, "output_format": output_format}, ensure_ascii=False
    ).encode()
    try:
        raw = await (_capture_remote(payload) if _remote() else _capture_local(payload))
        return _validate_results(raw, outputs)
    except RenderingError:
        raise
    except TimeoutError as error:
        raise RenderingError("Screenshot capture exceeded its time limit.") from error
    except Exception as error:
        # SDK errors can contain control-plane credentials; expose no raw detail.
        raise RenderingError(f"Screenshot capture failed ({type(error).__name__}).") from error
