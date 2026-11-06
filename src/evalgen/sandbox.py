"""Run generated Python evaluators behind an operating-system isolation boundary.

Uses hardened Docker locally and isolated Vercel Sandbox microVMs on Vercel.
There is deliberately no ordinary Python subprocess or native macOS fallback:
Darwin's resource limits do not reliably bound an evaluator's memory consumption.
"""

import asyncio
import json
import math
import os
import shutil
import signal
import subprocess
import tempfile
import uuid
from dataclasses import dataclass
from functools import cache

MAX_CODE_BYTES = 65_536
MAX_INPUT_BYTES = 2_097_152
MAX_OUTPUT_BYTES = 65_536
DOCKER_IMAGE = "python:3.14-alpine"

# This trusted runner is passed as an argument; generated source is JSON on stdin.
# In particular, neither source nor response text is interpolated into a shell.
_RUNNER = r"""
import contextlib
import ctypes
import json
import math
import os
import resource
import sys

os.environ.clear()
os.environ.update({"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": "/tmp"})
# Prevent setuid binaries/sudo from increasing privileges inside the isolated VM.
prctl = ctypes.CDLL(None, use_errno=True).prctl
prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
prctl.restype = ctypes.c_int
if prctl(38, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), "Could not enforce no_new_privs")

payload = json.loads(sys.stdin.buffer.read(2097153))
cpu = max(1, math.ceil(payload["timeout"]))
for name, value in (("RLIMIT_CPU", cpu), ("RLIMIT_FSIZE", 0),
                    ("RLIMIT_CORE", 0), ("RLIMIT_NOFILE", 32), ("RLIMIT_NPROC", 0)):
    resource.setrlimit(getattr(resource, name), (value, value))
for name in ("RLIMIT_AS", "RLIMIT_DATA"):
    resource.setrlimit(getattr(resource, name), (268435456, 268435456))

class QuietOutput:
    def __init__(self):
        self.size = 0
    def write(self, text):
        self.size += len(text)
        if self.size > 8192:
            raise RuntimeError("Evaluator exceeded the output limit")
        return len(text)
    def flush(self):
        pass

results, errors = [], []
namespace = {"__name__": "__evalgen_candidate__"}
quiet = QuietOutput()
def description(error):
    return (type(error).__name__ + ": " + str(error))[:300]

with contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
    try:
        exec(compile(payload["code"], "<generated evaluator>", "exec"), namespace)
        evaluate = namespace.get("evaluate")
        if not callable(evaluate):
            raise TypeError("Define evaluate(response, prompt) returning a bool")
    except BaseException as error:
        results = [None] * len(payload["outputs"])
        errors = [description(error)] * len(payload["outputs"])
    else:
        for output in payload["outputs"]:
            try:
                result = evaluate(output, payload["prompt"])
                if type(result) is not bool:
                    raise TypeError("evaluate must return an exact bool")
                results.append(result)
                errors.append(None)
            except BaseException as error:
                results.append(None)
                errors.append(description(error))
sys.stdout.write(json.dumps({"results": results, "errors": errors}))
"""


@dataclass(frozen=True)
class PythonEvaluation:
    results: list[bool | None]
    errors: list[str | None]
    backend: str | None


@dataclass(frozen=True)
class _Backend:
    name: str
    executable: str
    image: str
    host: str


def _environment(cwd: str) -> dict[str, str]:
    return {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": cwd, "TMPDIR": cwd}


def _command(backend: _Backend, name: str) -> list[str]:
    return [
        backend.executable,
        "--host",
        backend.host,
        "run",
        "--rm",
        "--pull",
        "never",
        "-i",
        "--name",
        name,
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "1",
        "--memory",
        "128m",
        "--memory-swap",
        "128m",
        "--cpus",
        "0.5",
        "--user",
        "65534:65534",
        "--workdir",
        "/tmp",
        "--log-driver",
        "none",
        "--ulimit",
        "nofile=32:32",
        "--ulimit",
        "fsize=0:0",
        "--ulimit",
        "core=0:0",
        "--entrypoint",
        "python",
        str(backend.image),
        "-I",
        "-S",
        "-B",
        "-c",
        _RUNNER,
    ]


@cache
def _backend() -> tuple[_Backend | None, str]:
    """Probe real isolation at startup and pin a Docker image by local image ID."""
    docker = shutil.which("docker")
    if docker:
        try:
            context = subprocess.run(
                [docker, "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
                capture_output=True,
                text=True,
                timeout=3,
            )
            host = os.environ.get("DOCKER_HOST") or context.stdout.strip()
            if not host or context.returncode:
                raise ValueError("Docker context is unavailable")
            image = subprocess.run(
                [docker, "--host", host, "image", "inspect", "--format", "{{.Id}}", DOCKER_IMAGE],
                capture_output=True,
                text=True,
                timeout=3,
            )
            if image.returncode == 0 and image.stdout.strip().startswith("sha256:"):
                candidate = _Backend("docker", docker, image.stdout.strip(), host)
                name = "evalgen-probe-" + uuid.uuid4().hex
                with tempfile.TemporaryDirectory(prefix="evalgen-sandbox-probe-") as cwd:
                    try:
                        probe = subprocess.run(
                            _command(candidate, name),
                            input=json.dumps(
                                {
                                    "code": "def evaluate(response, prompt): return True",
                                    "outputs": ["probe"],
                                    "prompt": "",
                                    "timeout": 2,
                                }
                            ),
                            capture_output=True,
                            text=True,
                            timeout=5,
                            cwd=cwd,
                            env=_environment(cwd),
                        )
                        if probe.returncode == 0 and json.loads(probe.stdout)["results"] == [True]:
                            return candidate, (
                                "Docker: no network, no host mounts, 128 MiB memory cap."
                            )
                    finally:
                        subprocess.run(
                            [docker, "--host", host, "rm", "-f", name],
                            capture_output=True,
                            timeout=3,
                        )
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            pass
    return None, (
        "No working OS sandbox. Install Docker and pull python:3.14-alpine to enable Python."
    )


def sandbox_status() -> dict[str, bool | str | None]:
    if _remote_requested():
        from evalgen.vercel_sandbox import remote_status

        return remote_status()
    backend, reason = _backend()
    return {
        "available": backend is not None,
        "backend": backend.name if backend else None,
        "reason": reason,
    }


def _remote_requested() -> bool:
    return os.environ.get("VERCEL") == "1" or os.environ.get("EVALGEN_SANDBOX_BACKEND") == "vercel"


async def _bounded_read(reader: asyncio.StreamReader, overflow: asyncio.Event) -> bytes:
    chunks = bytearray()
    while chunk := await reader.read(4096):
        if len(chunks) + len(chunk) > MAX_OUTPUT_BYTES:
            overflow.set()
        elif not overflow.is_set():
            chunks.extend(chunk)
    return bytes(chunks)


async def _remove_container(backend: _Backend, name: str) -> None:
    cleanup: asyncio.subprocess.Process | None = None
    try:
        cleanup = await asyncio.create_subprocess_exec(
            backend.executable,
            "--host",
            backend.host,
            "rm",
            "-f",
            name,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(cleanup.wait(), timeout=5)
    except (OSError, TimeoutError):
        if cleanup is not None and cleanup.returncode is None:
            cleanup.kill()
            await cleanup.wait()


async def evaluate_python_detailed(
    code: str, outputs: list[str], prompt: str, timeout: float = 3.0
) -> PythonEvaluation:
    """Evaluate an entire candidate under one wall/CPU budget; errors remain unknown."""
    remote = _remote_requested()
    backend, reason = (None, "") if remote else _backend()
    name = "evalgen-" + uuid.uuid4().hex
    backend_name = "vercel" if remote else (backend.name if backend else None)

    def failed(message: str) -> PythonEvaluation:
        return PythonEvaluation([None] * len(outputs), [message] * len(outputs), backend_name)

    if not outputs:
        return PythonEvaluation([], [], backend_name)
    if not backend and not remote:
        return failed(reason)
    if not math.isfinite(timeout) or not 0 < timeout <= 30:
        return failed("Timeout must be between 0 and 30 seconds")
    if len(code.encode()) > MAX_CODE_BYTES:
        return failed("Evaluator source exceeds the size limit")
    payload = json.dumps(
        {"code": code, "outputs": outputs, "prompt": prompt, "timeout": timeout}
    ).encode()
    if len(payload) > MAX_INPUT_BYTES:
        return failed("Evaluator input exceeds the size limit")

    if remote:
        from evalgen.vercel_sandbox import RemoteSandboxError, run_python

        try:
            result = await run_python(_RUNNER, payload, timeout, MAX_OUTPUT_BYTES)
            if result.returncode:
                detail = result.stderr.strip()[:300]
                return failed(f"Remote sandbox process failed ({result.returncode}): {detail}")
            data = json.loads(result.stdout)
            results, errors = data["results"], data["errors"]
            if (
                len(results) != len(outputs)
                or len(errors) != len(outputs)
                or any(value is not None and type(value) is not bool for value in results)
                or any(error is not None and not isinstance(error, str) for error in errors)
            ):
                raise ValueError("Invalid evaluator result")
            return PythonEvaluation(results, errors, backend_name)
        except (RemoteSandboxError, ValueError, KeyError, TypeError) as error:
            return failed(f"Remote sandbox execution error: {str(error)[:300]}")

    assert backend is not None

    process: asyncio.subprocess.Process | None = None
    readers: list[asyncio.Task[bytes]] = []
    exchange_task: asyncio.Task[tuple[bytes, bytes]] | None = None
    overflow_task: asyncio.Task[bool] | None = None
    try:
        with tempfile.TemporaryDirectory(prefix="evalgen-sandbox-") as cwd:
            process = await asyncio.create_subprocess_exec(
                *_command(backend, name),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=_environment(cwd),
                start_new_session=True,
                limit=8192,
            )
            assert process.stdin and process.stdout and process.stderr
            stdin = process.stdin
            overflow = asyncio.Event()
            readers = [
                asyncio.create_task(_bounded_read(process.stdout, overflow)),
                asyncio.create_task(_bounded_read(process.stderr, overflow)),
            ]

            async def exchange() -> tuple[bytes, bytes]:
                stdin.write(payload)
                await stdin.drain()
                stdin.close()
                stdout, stderr = await asyncio.gather(*readers)
                await process.wait()
                return stdout, stderr

            exchange_task = asyncio.create_task(exchange())
            overflow_task = asyncio.create_task(overflow.wait())
            done, _ = await asyncio.wait(
                [exchange_task, overflow_task],
                timeout=timeout,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not done:
                raise TimeoutError
            if overflow.is_set():
                raise ValueError("Evaluator exceeded the output limit")
            stdout, stderr = await exchange_task
            if process.returncode:
                detail = stderr.decode(errors="replace").strip()[:300]
                return failed(f"Sandbox process failed ({process.returncode}): {detail}")
            data = json.loads(stdout)
            results, errors = data["results"], data["errors"]
            if (
                len(results) != len(outputs)
                or len(errors) != len(outputs)
                or any(value is not None and type(value) is not bool for value in results)
                or any(error is not None and not isinstance(error, str) for error in errors)
            ):
                raise ValueError("Invalid evaluator result")
            return PythonEvaluation(results, errors, backend_name)
    except TimeoutError:
        return failed(f"Evaluator exceeded the {timeout:g}s wall time limit")
    except (OSError, ValueError, KeyError, TypeError) as error:
        return failed(f"Sandbox execution error: {str(error)[:300]}")
    finally:
        # Remove the container first: killing only the Docker client leaves its
        # evaluator running in the daemon, including one blocked on a full pipe.
        await _remove_container(backend, name)
        if process and process.returncode is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except PermissionError:
                # Some managed macOS hosts restrict process-group signals even
                # for a direct child. Its container has already been removed.
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            await process.wait()
        for task in (exchange_task, overflow_task):
            if task and not task.done():
                task.cancel()
        if exchange_task:
            await asyncio.gather(exchange_task, return_exceptions=True)
        if overflow_task:
            await asyncio.gather(overflow_task, return_exceptions=True)
        for reader in readers:
            if not reader.done():
                reader.cancel()
        if readers:
            await asyncio.gather(*readers, return_exceptions=True)
        # A cancellation during `docker run` can race the daemon's create step.
        # Retry removal after the client has exited as well.
        await _remove_container(backend, name)


async def evaluate_python(
    code: str, outputs: list[str], prompt: str, timeout: float = 3.0
) -> list[bool | None]:
    return (await evaluate_python_detailed(code, outputs, prompt, timeout)).results
