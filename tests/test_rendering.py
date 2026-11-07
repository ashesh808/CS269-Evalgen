"""Screenshot provenance, trust boundaries, and fail-closed capture behavior."""

import asyncio
import base64
import hashlib
import json
import struct
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from evalgen import rendering


def image(source: str, width: int = 960, height: int = 640) -> dict[str, object]:
    header = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + struct.pack(">II", width, height)
    return {
        "data_url": "data:image/png;base64," + base64.b64encode(header).decode(),
        "width": width,
        "height": height,
        "viewport": {"width": 960, "height": 640},
        "source_hash": hashlib.sha256(source.encode()).hexdigest(),
    }


def test_remote_status_checks_credentials_without_starting_a_vm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.setattr(rendering, "get_credentials", Mock(return_value=object()))
    create = Mock(side_effect=AssertionError("Status cannot create a VM"))
    monkeypatch.setattr(rendering.sdk, "create_sandbox", create)
    assert rendering.renderer_status()["available"] is True
    create.assert_not_called()


def test_remote_status_does_not_echo_credential_diagnostics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EVALGEN_SCREENSHOT_BACKEND", "vercel")
    monkeypatch.setattr(
        rendering, "get_credentials", Mock(side_effect=RuntimeError("private-token"))
    )
    status = rendering.renderer_status()
    assert status["available"] is False
    assert "private-token" not in str(status)


def test_local_status_reports_missing_prerequisites(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVALGEN_SCREENSHOT_BACKEND", "local")
    monkeypatch.setattr(rendering.shutil, "which", lambda _: None)
    assert rendering.renderer_status()["available"] is False


def test_browser_process_environment_does_not_inherit_credentials(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("EVALGEN_API_KEY", "private-key")
    monkeypatch.setenv("VERCEL_OIDC_TOKEN", "private-oidc")
    env = rendering._clean_env(tmp_path)
    assert "private-key" not in str(env) and "private-oidc" not in str(env)
    assert "EVALGEN_API_KEY" not in env
    assert "VERCEL_OIDC_TOKEN" not in env
    assert env["HOME"] == str(tmp_path)
    assert env["npm_config_registry"] == "https://registry.npmjs.org"


def test_capture_preserves_source_order_and_per_output_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sources = ["<svg/>", "No artifact"]
    expected = [image(sources[0]), {
        "source_hash": hashlib.sha256(sources[1].encode()).hexdigest(),
        "error": "No complete SVG design was found in the response.",
    }]
    capture = AsyncMock(return_value=json.dumps(expected).encode())
    monkeypatch.setattr(rendering, "renderer_status", lambda: {"available": True})
    monkeypatch.setattr(rendering, "_remote", lambda: False)
    monkeypatch.setattr(rendering, "_capture_local", capture)
    assert asyncio.run(rendering.render_previews(sources, "svg")) == expected
    assert json.loads(capture.call_args.args[0]) == {
        "outputs": sources, "output_format": "svg"
    }


@pytest.mark.parametrize(
    ("sources", "output_format"),
    [([], "svg"), (["x"] * 11, "svg"), (["x"], "text"), (["x" * 100_001], "html")],
)
def test_invalid_capture_requests_do_not_start_a_browser(
    monkeypatch: pytest.MonkeyPatch, sources: list[str], output_format: str
) -> None:
    capture = AsyncMock(side_effect=AssertionError("Must validate first"))
    monkeypatch.setattr(rendering, "_capture_local", capture)
    with pytest.raises(ValueError):
        asyncio.run(rendering.render_previews(sources, output_format))  # type: ignore[arg-type]
    capture.assert_not_called()


@pytest.mark.parametrize("raw", [b"bad json", b"[]", b"{}", b"[null]"])
def test_malformed_renderer_results_cannot_become_screenshots(raw: bytes) -> None:
    with pytest.raises(rendering.RenderingError):
        rendering._validate_results(raw, ["source"])


@pytest.mark.parametrize("change", ["hash", "base64", "width", "metadata", "viewport"])
def test_renderer_validates_image_provenance_and_dimensions(change: str) -> None:
    result = image("source")
    if change == "hash":
        result["source_hash"] = "0" * 64
    elif change == "base64":
        result["data_url"] = "data:image/png;base64,!not-base64"
    elif change == "width":
        result = image("source", 10_000, 640)
    elif change == "metadata":
        result["height"] = 2000
    else:
        result["viewport"] = {"width": 100, "height": 100}
    with pytest.raises(rendering.RenderingError):
        rendering._validate_results(json.dumps([result]).encode(), ["source"])


def test_provider_errors_are_redacted_without_falling_back_to_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(rendering, "renderer_status", lambda: {"available": True})
    monkeypatch.setattr(rendering, "_remote", lambda: True)
    monkeypatch.setattr(
        rendering, "_capture_remote", AsyncMock(side_effect=RuntimeError("private-token"))
    )
    fallback = AsyncMock(side_effect=AssertionError("No local fallback"))
    monkeypatch.setattr(rendering, "_capture_local", fallback)
    with pytest.raises(rendering.RenderingError, match="RuntimeError") as error:
        asyncio.run(rendering.render_previews(["<svg/>"], "svg"))
    assert "private-token" not in str(error.value)
    fallback.assert_not_called()


def test_local_command_bounds_unexpected_process_output(tmp_path: Path) -> None:
    async def flood() -> None:
        await rendering._run_local_command(
            sys.executable,
            ["-I", "-c", "import sys;sys.stdout.write('x'*10000)"],
            cwd=tmp_path,
            env=rendering._clean_env(tmp_path),
            timeout=3,
            max_output=100,
        )
    with pytest.raises(rendering.RenderingError, match="output limit"):
        asyncio.run(flood())


class FakeSandboxOperation:
    def __init__(self, box: object, events: list[str]) -> None:
        self.box, self.events = box, events

    async def __aenter__(self) -> object:
        return self.box

    async def __aexit__(self, *args: object) -> None:
        self.events.append("destroyed")


def test_remote_installs_trusted_packages_then_denies_network_before_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []

    async def write(path: str, value: object) -> None:
        if path.endswith("input.json"):
            assert "denied" in events
            events.append("source uploaded")

    fs = SimpleNamespace(
        write_text=AsyncMock(side_effect=write),
        write_bytes=AsyncMock(side_effect=write),
        read_bytes=AsyncMock(return_value=b"[]"),
    )
    run = AsyncMock(return_value=SimpleNamespace(returncode=0))
    user = SimpleNamespace(fs=fs, run_command=run)
    box = SimpleNamespace(
        create_user=AsyncMock(return_value=user),
        update_network_policy=AsyncMock(side_effect=lambda _: events.append("denied")),
    )
    create = Mock(return_value=FakeSandboxOperation(box, events))
    monkeypatch.setattr(rendering.sdk, "create_sandbox", create)
    monkeypatch.setenv("EVALGEN_API_KEY", "not-for-browser")
    assert asyncio.run(rendering._capture_remote(b"source")) == b"[]"
    options = create.call_args.kwargs
    assert options["network_policy"].mode == "custom"
    assert list(options["network_policy"].allow) == ["registry.npmjs.org"]
    assert options["env"] == {} and options["mounts"] == {} and options["ports"] == []
    assert options["persistent"] is False
    assert box.update_network_policy.call_args.args[0].mode == "deny-all"
    assert events == ["denied", "source uploaded", "destroyed"]
    assert run.call_count == 2
    assert "--ignore-scripts" in run.call_args_list[0].args[1]
    assert all(call.kwargs["env"] == {} for call in run.call_args_list)
    assert "not-for-browser" not in str(run.call_args_list)


def test_remote_bootstrap_failure_always_exits_microvm_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    fs = SimpleNamespace(write_text=AsyncMock(), write_bytes=AsyncMock())
    user = SimpleNamespace(
        fs=fs, run_command=AsyncMock(return_value=SimpleNamespace(returncode=1))
    )
    box = SimpleNamespace(create_user=AsyncMock(return_value=user))
    monkeypatch.setattr(
        rendering.sdk, "create_sandbox", Mock(return_value=FakeSandboxOperation(box, events))
    )
    with pytest.raises(rendering.RenderingError, match="prepare"):
        asyncio.run(rendering._capture_remote(b"source"))
    assert events == ["destroyed"]
    fs.write_bytes.assert_not_called()
