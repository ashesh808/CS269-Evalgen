"""Ephemeral, offline Vercel Sandbox execution for deployed Python evaluators.

The isolation boundary is a Linux microVM with its own writable filesystem, not
the local Docker backend's read-only root. A dedicated unprivileged account runs
the trusted runner, which enforces no_new_privs and hard per-process resource
limits before it sees generated code. Application credentials remain outside.
"""

import asyncio
import io
import uuid
from dataclasses import dataclass
from typing import TextIO, cast

from vercel import sandbox as sdk
from vercel.oidc.credentials import get_credentials
from vercel.sandbox import NetworkPolicy, Sandbox, SandboxResources

_SDK_FAILURES = (sdk.SandboxError, OSError, RuntimeError, ValueError, TimeoutError)


class RemoteSandboxError(RuntimeError):
    """A fail-closed remote setup, execution, output, or cleanup error."""


@dataclass(frozen=True)
class RemoteProcessResult:
    stdout: str
    stderr: str
    returncode: int


class _OutputBudget:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.used = 0


class _BoundedOutput(io.TextIOBase):
    def __init__(self, budget: _OutputBudget) -> None:
        self.budget = budget
        self.chunks: list[str] = []

    def writable(self) -> bool:
        return True

    def write(self, text: str) -> int:
        size = len(text.encode())
        if self.budget.used + size > self.budget.limit:
            raise RemoteSandboxError("Evaluator exceeded the output limit")
        self.budget.used += size
        self.chunks.append(text)
        return len(text)

    def flush(self) -> None:
        pass

    def value(self) -> str:
        return "".join(self.chunks)


def remote_status() -> dict[str, bool | str | None]:
    """Check ambient SDK credentials without starting or billing for a microVM."""
    try:
        get_credentials()
    except _SDK_FAILURES:
        # Never echo an SDK credential exception or token into the app response.
        return {
            "available": False,
            "backend": "vercel",
            "reason": "Vercel Sandbox requires project OIDC or configured SDK credentials.",
        }
    return {
        "available": True,
        "backend": "vercel",
        "reason": "Vercel microVM: offline, no host mounts, 256 MiB evaluator process limit.",
    }


async def _cleanup(box: Sandbox) -> None:
    failed = False
    try:
        await asyncio.wait_for(box.stop(), timeout=5)
    except _SDK_FAILURES:
        failed = True
    try:
        await asyncio.wait_for(box.destroy(delete_orphan_snapshots=True), timeout=5)
    except _SDK_FAILURES:
        failed = True
    if failed:
        raise RemoteSandboxError(
            "Could not confirm remote sandbox cleanup; session runtime is capped"
        )


async def run_python(
    runner: str, payload: bytes, timeout: float, max_output: int
) -> RemoteProcessResult:
    """Run one candidate offline, then stop and destroy its dedicated microVM."""
    if not remote_status()["available"]:
        raise RemoteSandboxError("Vercel Sandbox credentials are unavailable")
    box: Sandbox | None = None
    creation: asyncio.Future[Sandbox] | None = None
    name = "evalgen-" + uuid.uuid4().hex
    budget = _OutputBudget(max_output)
    stdout, stderr = _BoundedOutput(budget), _BoundedOutput(budget)
    try:
        # The VM has provider-minimum RAM (2 GiB/vCPU), while the evaluator
        # process is limited to 256 MiB by the trusted Linux runner.
        async with asyncio.timeout(timeout + 20):
            creation = asyncio.ensure_future(
                sdk.create_sandbox(
                    name=name,
                    persistent=False,
                    network_policy=NetworkPolicy.deny_all(),
                    resources=SandboxResources(vcpus=1, memory=2048),
                    execution_time_limit=timeout + 15,
                    ports=[],
                    env={},
                    mounts={},
                )
            )
            # Keep the handle obtainable for cleanup if a request is cancelled
            # while the provider is still booting its microVM.
            box = await asyncio.shield(creation)
            assert box is not None
            user = await box.create_user("evalgen")
            result = await user.run_command(
                "/usr/bin/env",
                [
                    "-i",
                    "PATH=/usr/local/bin:/usr/bin:/bin",
                    "LANG=C.UTF-8",
                    "HOME=/home/evalgen",
                    "python",
                    "-I",
                    "-S",
                    "-B",
                    "-c",
                    runner,
                ],
                cwd="/home/evalgen",
                env={},
                sudo=False,
                input=payload,
                stdout=cast(TextIO, stdout),
                stderr=cast(TextIO, stderr),
                kill_after=timeout,
                check=False,
            )
            return RemoteProcessResult(stdout.value(), stderr.value(), result.returncode)
    except RemoteSandboxError:
        raise
    except TimeoutError as error:
        raise RemoteSandboxError("Remote evaluator exceeded its wall time limit") from error
    except Exception as error:
        # SDK errors can include transport/auth details. Return only the class,
        # leaving any credential-bearing exception body outside the app payload.
        status = getattr(error, "status_code", None)
        suffix = f", HTTP {status}" if type(status) is int else ""
        message = f"Vercel Sandbox failed ({type(error).__name__}{suffix})"
        raise RemoteSandboxError(message) from error
    finally:
        if box is None and creation is not None:
            try:
                box = await asyncio.wait_for(asyncio.shield(creation), timeout=10)
            except _SDK_FAILURES:
                creation.cancel()
                await asyncio.gather(creation, return_exceptions=True)
                try:
                    box = await asyncio.wait_for(sdk.get_sandbox(name=name), timeout=5)
                except _SDK_FAILURES:
                    # Even if control-plane recovery fails, the independent
                    # short VM execution limit still stops any orphaned process.
                    pass
        if box is not None:
            cleanup = asyncio.create_task(_cleanup(box))
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                await cleanup
                raise
