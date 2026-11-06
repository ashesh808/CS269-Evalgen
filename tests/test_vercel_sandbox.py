import asyncio
import io
import json
from types import SimpleNamespace
from typing import cast
from unittest.mock import AsyncMock, Mock

import pytest

from evalgen import sandbox, vercel_sandbox


def write(kwargs: dict[str, object], stream: str, text: str) -> None:
    cast(io.TextIOBase, kwargs[stream]).write(text)


@pytest.fixture
def remote(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    monkeypatch.setenv("EVALGEN_SANDBOX_BACKEND", "vercel")
    monkeypatch.setenv("EVALGEN_API_KEY", "not-for-the-microvm")
    monkeypatch.setattr(vercel_sandbox, "get_credentials", Mock(return_value=object()))

    async def answer(*args: object, **kwargs: object) -> SimpleNamespace:
        write(kwargs, "stdout", json.dumps({"results": [True, False], "errors": [None, None]}))
        return SimpleNamespace(returncode=0)

    user = SimpleNamespace(run_command=AsyncMock(side_effect=answer))
    box = SimpleNamespace(
        create_user=AsyncMock(return_value=user),
        stop=AsyncMock(),
        destroy=AsyncMock(),
    )
    create = AsyncMock(return_value=box)
    monkeypatch.setattr(vercel_sandbox.sdk, "create_sandbox", create)
    return SimpleNamespace(create=create, box=box, user=user)


def evaluate() -> sandbox.PythonEvaluation:
    return asyncio.run(
        sandbox.evaluate_python_detailed(
            "def evaluate(response, prompt): return bool(response)", ["hello", ""], "task"
        )
    )


def test_deployed_runtime_selects_remote_backend(
    remote: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("EVALGEN_SANDBOX_BACKEND")
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.setattr(
        sandbox, "_backend", Mock(side_effect=AssertionError("No Docker on Vercel"))
    )
    result = evaluate()
    assert result.results == [True, False]
    assert result.backend == "vercel"


def test_remote_vm_is_ephemeral_offline_and_contains_no_application_env(
    remote: SimpleNamespace,
) -> None:
    assert evaluate().results == [True, False]
    options = remote.create.call_args.kwargs
    assert options["network_policy"].mode == "deny-all"
    assert options["persistent"] is False
    assert options["env"] == {}
    assert options["ports"] == []
    assert options["mounts"] == {}
    assert options["execution_time_limit"] == 18
    assert options["resources"].vcpus == 1
    assert options["resources"].memory == 2048
    remote.box.create_user.assert_awaited_once_with("evalgen")
    args, command = remote.user.run_command.call_args
    assert args[0] == "/usr/bin/env"
    assert args[1][0] == "-i"
    assert args[1][-6:-1] == ["python", "-I", "-S", "-B", "-c"]
    assert command["env"] == {}
    assert command["sudo"] is False
    assert command["kill_after"] == 3
    assert "not-for-the-microvm" not in str(remote.create.call_args)
    assert "not-for-the-microvm" not in str(remote.user.run_command.call_args)
    payload = json.loads(command["input"])
    assert payload["outputs"] == ["hello", ""]
    assert payload["prompt"] == "task"
    assert not command.get("capture_output", False)
    remote.box.stop.assert_awaited_once()
    remote.box.destroy.assert_awaited_once_with(delete_orphan_snapshots=True)


def test_status_checks_credentials_without_creating_a_vm(remote: SimpleNamespace) -> None:
    status = sandbox.sandbox_status()
    assert status["available"] is True
    assert status["backend"] == "vercel"
    remote.create.assert_not_called()


def test_missing_credentials_fail_closed_without_docker_or_credential_echo(
    remote: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        vercel_sandbox, "get_credentials", Mock(side_effect=RuntimeError("private-credential"))
    )
    monkeypatch.setattr(sandbox, "_backend", Mock(side_effect=AssertionError("No fallback")))
    status = sandbox.sandbox_status()
    result = evaluate()
    assert status["available"] is False
    assert "private-credential" not in str(status)
    assert result.results == [None, None]
    assert "private-credential" not in str(result.errors)
    remote.create.assert_not_called()


@pytest.mark.parametrize(
    "stdout",
    [
        "not-json",
        '{"results": [1, false], "errors": [null, null]}',
        '{"results": [true], "errors": [null]}',
    ],
)
def test_malformed_remote_result_is_unknown_and_vm_is_destroyed(
    remote: SimpleNamespace, stdout: str
) -> None:
    async def answer(*args: object, **kwargs: object) -> SimpleNamespace:
        write(kwargs, "stdout", stdout)
        return SimpleNamespace(returncode=0)

    remote.user.run_command.side_effect = answer
    result = evaluate()
    assert result.results == [None, None]
    assert all(result.errors)
    remote.box.stop.assert_awaited_once()
    remote.box.destroy.assert_awaited_once()


def test_remote_output_flood_is_bounded_and_vm_is_destroyed(remote: SimpleNamespace) -> None:
    async def flood(*args: object, **kwargs: object) -> None:
        write(kwargs, "stdout", "x" * (sandbox.MAX_OUTPUT_BYTES + 1))

    remote.user.run_command.side_effect = flood
    result = evaluate()
    assert result.results == [None, None]
    assert "output limit" in (result.errors[0] or "")
    remote.box.stop.assert_awaited_once()
    remote.box.destroy.assert_awaited_once()


def test_stderr_shares_the_remote_output_budget(remote: SimpleNamespace) -> None:
    async def flood(*args: object, **kwargs: object) -> None:
        write(kwargs, "stdout", "x" * (sandbox.MAX_OUTPUT_BYTES // 2))
        write(kwargs, "stderr", "y" * (sandbox.MAX_OUTPUT_BYTES // 2 + 1))

    remote.user.run_command.side_effect = flood
    assert "output limit" in (evaluate().errors[0] or "")
    remote.box.destroy.assert_awaited_once()


def test_sdk_failure_is_redacted_and_vm_is_destroyed(remote: SimpleNamespace) -> None:
    remote.user.run_command.side_effect = RuntimeError("secret-token")
    result = evaluate()
    assert result.results == [None, None]
    assert "RuntimeError" in (result.errors[0] or "")
    assert "secret-token" not in (result.errors[0] or "")
    remote.box.stop.assert_awaited_once()
    remote.box.destroy.assert_awaited_once()


def test_process_failure_reports_bounded_isolated_stderr(remote: SimpleNamespace) -> None:
    async def answer(*args: object, **kwargs: object) -> SimpleNamespace:
        write(kwargs, "stderr", "python unavailable")
        return SimpleNamespace(returncode=127)

    remote.user.run_command.side_effect = answer
    result = evaluate()
    assert result.results == [None, None]
    assert "127" in (result.errors[0] or "")
    assert "python unavailable" in (result.errors[0] or "")
    remote.box.destroy.assert_awaited_once()


@pytest.mark.parametrize("during_creation", [False, True])
def test_cancelled_request_stops_and_destroys_vm(
    remote: SimpleNamespace, during_creation: bool
) -> None:
    async def cancel() -> None:
        reached = asyncio.Event()

        async def blocked(*args: object, **kwargs: object) -> None:
            reached.set()
            await asyncio.sleep(20)

        async def boot(*args: object, **kwargs: object) -> object:
            reached.set()
            await asyncio.sleep(0.05)
            return remote.box

        if during_creation:
            remote.create.side_effect = boot
        else:
            remote.user.run_command.side_effect = blocked
        task = asyncio.create_task(
            sandbox.evaluate_python_detailed(
                "def evaluate(response, prompt): return True", ["output"], "task"
            )
        )
        await reached.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(cancel())
    remote.box.stop.assert_awaited_once()
    remote.box.destroy.assert_awaited_once_with(delete_orphan_snapshots=True)


def test_failed_stop_still_attempts_destroy(remote: SimpleNamespace) -> None:
    remote.box.stop.side_effect = RuntimeError("stop failed")
    result = evaluate()
    assert result.results == [None, None]
    assert "cleanup" in (result.errors[0] or "")
    remote.box.destroy.assert_awaited_once()
