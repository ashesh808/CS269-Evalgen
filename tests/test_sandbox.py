import asyncio
import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest

from evalgen import sandbox


@pytest.fixture
def isolated(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    status = sandbox.sandbox_status()
    if not status["available"]:
        pytest.skip(str(status["reason"]))
    backend, _ = sandbox._backend()
    assert backend is not None
    original_command = sandbox._command
    names = []

    def command(backend: sandbox._Backend, name: str) -> list[str]:
        names.append(name)
        return original_command(backend, name)

    monkeypatch.setattr(sandbox, "_command", command)
    yield
    for name in names:
        remaining = subprocess.run(
            [backend.executable, "--host", backend.host, "container", "inspect", name],
            capture_output=True,
            text=True,
            timeout=3,
        )
        assert remaining.returncode != 0, f"Sandbox container leaked: {name}"


def run(
    code: str, outputs: list[str] | None = None, timeout: float = 3.0
) -> sandbox.PythonEvaluation:
    return asyncio.run(
        sandbox.evaluate_python_detailed(code, outputs or ["hello"], "task", timeout)
    )


def test_real_sandbox_runs_stdlib_and_uses_prompt(isolated: None) -> None:
    result = run(
        "import json, re\n"
        "def evaluate(response, prompt):\n"
        "    return prompt == 'task' and bool(re.fullmatch(r'[a-z]+', json.loads(response)))",
        ['"hello"', '"123"'],
    )
    assert result.results == [True, False]
    assert result.errors == [None, None]
    assert result.backend == "docker"


@pytest.mark.parametrize(
    "code",
    [
        "not valid Python!",
        "def evaluate(response, prompt): return 1",
        "def evaluate(response, prompt): return 'true'",
        "def another_function(response, prompt): return True",
    ],
)
def test_invalid_candidates_are_unknown(isolated: None, code: str) -> None:
    result = run(code)
    assert result.results == [None]
    assert result.errors[0]


def test_one_output_error_does_not_discard_valid_outputs(isolated: None) -> None:
    result = run("def evaluate(response, prompt): return 1 / int(response) > 0", ["0", "1"])
    assert result.results == [None, True]
    assert result.errors[0].startswith("ZeroDivisionError:")
    assert result.errors[1] is None


def test_parent_environment_is_not_inherited(
    isolated: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("EVALGEN_TEST_SECRET", "sentinel-secret")
    result = run(
        "import os\n"
        "def evaluate(response, prompt):\n"
        "    return 'EVALGEN_TEST_SECRET' not in os.environ and 'EVALGEN_API_KEY' not in os.environ"
    )
    assert result.results == [True]


def test_host_file_read_is_denied(isolated: None, tmp_path: Path) -> None:
    sentinel = tmp_path / "private-sentinel.txt"
    sentinel.write_text("not-for-the-evaluator")
    result = run(f"def evaluate(response, prompt): return bool(open({str(sentinel)!r}).read())")
    assert result.results == [None]
    assert result.errors[0]


def test_host_file_write_is_denied(isolated: None, tmp_path: Path) -> None:
    destination = tmp_path / "should-not-exist.txt"
    result = run(f"def evaluate(response, prompt): return bool(open({str(destination)!r}, 'w'))")
    assert result.results == [None]
    assert not destination.exists()


def test_network_is_denied(isolated: None) -> None:
    result = run(
        "import socket\n"
        "def evaluate(response, prompt):\n"
        "    socket.create_connection(('127.0.0.1', 8269), timeout=0.2)\n"
        "    return True"
    )
    assert result.results == [None]
    assert result.errors[0]


def test_subprocess_creation_is_denied(isolated: None) -> None:
    result = run(
        "import subprocess, sys\n"
        "def evaluate(response, prompt):\n"
        "    subprocess.run([sys.executable, '-I', '-S', '-c', 'pass'], check=True)\n"
        "    return True"
    )
    assert result.results == [None]
    assert result.errors[0]


def test_infinite_loop_has_wall_timeout(isolated: None) -> None:
    result = run("def evaluate(response, prompt):\n    while True: pass", timeout=0.2)
    assert result.results == [None]
    assert "wall time" in result.errors[0]


def test_large_allocations_are_limited(isolated: None) -> None:
    result = run(
        "def evaluate(response, prompt):\n    data = bytearray(536870912)\n    return True"
    )
    assert result.results == [None]
    assert result.errors[0]


def test_raw_stdout_flood_is_bounded(isolated: None) -> None:
    result = run(
        "import os\ndef evaluate(response, prompt):\n    while True: os.write(1, b'x' * 8192)",
        timeout=1,
    )
    assert result.results == [None]
    assert "output limit" in result.errors[0]


def test_container_root_is_read_only(isolated: None) -> None:
    result = run("def evaluate(response, prompt):\n    open('/tmp/new-file', 'w')\n    return True")
    assert result.results == [None]
    assert "Read-only file system" in result.errors[0]


def test_corrupt_protocol_is_unknown_and_container_removed(isolated: None) -> None:
    result = run(
        "import os\ndef evaluate(response, prompt):\n    os.write(1, b'not-json')\n    return True"
    )
    assert result.results == [None]
    assert result.errors[0]


def test_cancelled_execution_removes_container(isolated: None) -> None:
    async def cancel() -> None:
        task = asyncio.create_task(
            sandbox.evaluate_python_detailed(
                "import time\ndef evaluate(response, prompt):\n    time.sleep(20)\n    return True",
                ["output"],
                "task",
                timeout=10,
            )
        )
        await asyncio.sleep(0.5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(cancel())


def test_no_unsandboxed_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sandbox, "_backend", lambda: (None, "No OS sandbox"))
    result = run("def evaluate(response, prompt): return True")
    assert result.results == [None]
    assert result.errors == ["No OS sandbox"]
    assert result.backend is None


def test_source_size_is_limited(isolated: None) -> None:
    result = run("#" * (sandbox.MAX_CODE_BYTES + 1))
    assert result.results == [None]
    assert "source exceeds" in result.errors[0]


def test_simple_api_returns_only_verdicts(isolated: None) -> None:
    result = asyncio.run(
        sandbox.evaluate_python(
            "def evaluate(response, prompt): return bool(response)", ["yes", ""], "task"
        )
    )
    assert result == [True, False]
