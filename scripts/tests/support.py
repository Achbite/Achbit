"""Shared local Provider transport and owned Host/CLI lifecycle for focused E2E scripts."""
from __future__ import annotations
import http.server
import json
import os
import secrets
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[2]


HOST_TOKEN_HEADER = "x-deepcode-host-shell-token"


COMMAND_VERSION = "deepcode.command.v3"


URL_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def runtime_path(environment_name: str) -> Path:
    configured = os.environ.get(environment_name)
    if not configured:
        raise RuntimeError(f"Set {environment_name} to the runtime being verified; test.sh supplies its own build outputs.")
    return Path(configured).resolve()


DAEMON_BINARY = runtime_path("DEEPCODE_E2E_DAEMON")


CLI_BINARY = runtime_path("DEEPCODE_E2E_CLI")


TUI_BINARY = runtime_path("DEEPCODE_E2E_TUI")


SESSION_BRIDGE = runtime_path("DEEPCODE_E2E_SESSION_BRIDGE")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def provider_usage() -> dict[str, Any]:
    return {
        "prompt_tokens": 100,
        "completion_tokens": 10,
        "prompt_tokens_details": {"cached_tokens": 40},
    }


def message_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


class OwnedDaemon:
    def __init__(self, config_root: Path) -> None:
        self.config_root = config_root
        self.token = f"dchost_{secrets.token_hex(32)}"
        self.instance_id = f"dcinstance_{secrets.token_hex(32)}"
        self.port = free_port()
        self.base_url = f"http://127.0.0.1:{self.port}"
        self.log_file = tempfile.TemporaryFile(mode="w+b")
        self.process: subprocess.Popen[bytes] | None = None
        self.identity: dict[str, Any] | None = None

    def start(self) -> None:
        node = shutil.which("node")
        require(node is not None, "找不到 Node runtime")
        require(DAEMON_BINARY.is_file(), f"缺少 Daemon：{DAEMON_BINARY}")
        require(SESSION_BRIDGE.is_file(), f"缺少 Session bridge：{SESSION_BRIDGE}")
        environment = os.environ.copy()
        for name in list(environment):
            if name.lower() in {"http_proxy", "https_proxy", "all_proxy"}:
                environment.pop(name, None)
        environment.update({
            "DEEPCODE_HOST": "127.0.0.1",
            "DEEPCODE_PORT": str(self.port),
            "DEEPCODE_USER_ROOT": str(self.config_root),
            "DEEPCODE_HOST_SHELL_TOKEN": self.token,
            "DEEPCODE_HOST_INSTANCE_ID": self.instance_id,
            "DEEPCODE_SESSION_BRIDGE": str(SESSION_BRIDGE),
            "DEEPCODE_NODE": node,
            "DEEPCODE_LLM_API_KEY": "e2e-key",
            "NO_PROXY": "127.0.0.1,localhost",
            "no_proxy": "127.0.0.1,localhost",
            "RUST_BACKTRACE": "1",
        })
        self.process = subprocess.Popen(
            [str(DAEMON_BINARY)],
            cwd=ROOT,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=self.log_file,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )

        def ready() -> dict[str, Any] | None:
            if self.process is not None and self.process.poll() is not None:
                raise AssertionError(
                    f"Daemon 提前退出 code={self.process.returncode}\n{self.log_tail()}"
                )
            try:
                value = api_json(self.base_url, "/api/host/identity")
                return value if isinstance(value, dict) else None
            except (OSError, ValueError, urllib.error.URLError):
                return None

        self.identity = wait_until(ready, 12, "Daemon 未进入 ready")
        require(self.identity.get("instanceId") == self.instance_id, "Daemon identity 不匹配")

    def shutdown(self) -> None:
        require(self.process is not None, "Daemon 尚未启动")
        require(self.identity is not None, "Daemon identity 不存在")
        receipt = api_json(
            self.base_url,
            "/api/host/shutdown",
            token=self.token,
            method="POST",
            body={"expectedIdentity": self.identity},
            timeout=90,
        )
        require(isinstance(receipt, dict), "shutdown receipt 不是对象")
        require(receipt.get("accepted") is True, "Daemon 未接受 shutdown")
        require(receipt.get("cleanupComplete") is True, f"Daemon 资源未完整清理：{receipt}")
        require(receipt.get("identity") == self.identity, "shutdown identity 漂移")
        try:
            code = self.process.wait(timeout=10)
        except subprocess.TimeoutExpired as error:
            self.terminate_group()
            raise AssertionError("Daemon 接受 shutdown 后未退出") from error
        require(code == 0, f"Daemon shutdown 后退出码为 {code}\n{self.log_tail()}")

    def terminate_group(self) -> None:
        if self.process is None:
            return
        if os.name == "nt":
            if self.process.poll() is not None:
                return
            subprocess.run(
                ["taskkill", "/PID", str(self.process.pid), "/T", "/F"],
                capture_output=True, timeout=5, creationflags=subprocess.CREATE_NO_WINDOW,
            )
            self.process.wait(timeout=5)
            return

        # start_new_session gives this fixture its own group. Its leader can
        # already be reaped while a child still holds files or listening ports.
        group = self.process.pid
        for stop_signal in (signal.SIGTERM, signal.SIGKILL):
            self.process.poll()
            try:
                os.killpg(group, stop_signal)
            except ProcessLookupError:
                return
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                self.process.poll()
                try:
                    os.killpg(group, 0)
                except ProcessLookupError:
                    return
                time.sleep(0.05)
        raise TimeoutError(f"Owned Daemon process group {group} did not exit")

    def close(self) -> None:
        try:
            if self.identity is not None and self.process is not None and self.process.poll() is None:
                self.shutdown()
        finally:
            primary_error = sys.exc_info()[1]
            try:
                self.terminate_group()
            except Exception as cleanup_error:
                if primary_error is None:
                    raise
                print(f"Owned Daemon cleanup also failed: {cleanup_error}", file=sys.stderr)
            finally:
                self.log_file.close()

    def log_tail(self) -> str:
        self.log_file.flush()
        position = self.log_file.tell()
        self.log_file.seek(0)
        content = self.log_file.read().decode("utf-8", errors="replace")
        self.log_file.seek(position)
        return content[-12000:]


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as handle:
        handle.bind(("127.0.0.1", 0))
        return int(handle.getsockname()[1])


def wait_until(operation: Callable[[], Any], timeout: float, message: str) -> Any:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            value = operation()
            if value:
                return value
        except AssertionError:
            raise
        except Exception as error:
            last_error = error
        time.sleep(0.05)
    suffix = f": {last_error}" if last_error else ""
    raise AssertionError(f"{message}{suffix}")


def api_envelope(
    base_url: str,
    path: str,
    *,
    token: str | None = None,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    timeout: float = 5,
) -> dict[str, Any]:
    encoded = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
    headers = {"accept": "application/json"}
    if encoded is not None:
        headers["content-type"] = "application/json"
    if token is not None:
        headers[HOST_TOKEN_HEADER] = token
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=encoded,
        headers=headers,
        method=method,
    )
    try:
        with URL_OPENER.open(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as error:
        raw = error.read()
    envelope = json.loads(raw)
    require(isinstance(envelope, dict), f"{path} 返回的 envelope 不是对象")
    return envelope


def api_json(
    base_url: str,
    path: str,
    *,
    token: str | None = None,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    timeout: float = 5,
) -> Any:
    envelope = api_envelope(
        base_url,
        path,
        token=token,
        method=method,
        body=body,
        timeout=timeout,
    )
    require(
        envelope.get("ok") is True,
        f"{path} 失败：{envelope.get('error')} {envelope.get('message')}",
    )
    return envelope.get("data")


def projection(daemon: OwnedDaemon, session_id: str) -> dict[str, Any]:
    path_id = urllib.parse.quote(session_id, safe="")
    value = api_json(
        daemon.base_url,
        f"/api/conversation/sessions/{path_id}/projection",
        token=daemon.token,
    )
    require(isinstance(value, dict), "SessionProjection 不是对象")
    require(value.get("schemaVersion") == "deepcode.session-projection.v6", "投影协议不是当前值")
    require(value.get("sessionId") == session_id, "SessionProjection identity 漂移")
    return value


def wait_completed(
    daemon: OwnedDaemon,
    provider: ProviderState,
    session_id: str,
    label: str,
) -> dict[str, Any]:
    def current_if_ready() -> dict[str, Any] | None:
        provider.assert_healthy()
        current = projection(daemon, session_id)
        run = current.get("run") or {}
        if run.get("status") == "completed":
            return current
        if run.get("status") in {"failed", "cancelled", "indeterminate"}:
            raise AssertionError(
                f"Session 在到达 {label} 前终止：{run.get('status')} {current.get('terminalError')}"
                f"\ndaemon:\n{daemon.log_tail()}"
            )
        return None

    return wait_until(current_if_ready, 20, f"Session 未到达 {label}")


def create_session(daemon: OwnedDaemon, workspace_path: Path) -> dict[str, Any]:
    value = api_json(
        daemon.base_url,
        "/api/conversation/sessions",
        token=daemon.token,
        method="POST",
        body={"workspacePaths": [str(workspace_path)]},
        timeout=12,
    )
    require(isinstance(value, dict), "create Session 未返回 projection")
    require(isinstance(value.get("sessionId"), str), "Session id 无效")
    return value


def write_configuration(
    config_root: Path,
    provider_url: str,
    settings: dict[str, Any],
) -> None:
    settings_root = config_root / "config" / "user" / "local" / "settings"
    settings_root.mkdir(parents=True)
    profile = {
        "profiles": [{
            "id": "e2e-main",
            "name": "Local E2E",
            "kind": "openaiCompatible",
            "providerFlavor": "openai",
            "baseUrl": provider_url,
            "model": "mock-main",
            "contextWindowTokens": 65536,
            "maxOutputTokens": 512,
            "enabled": True,
        }],
        "defaultProfileId": "e2e-main",
    }
    (settings_root / "llm-profiles.json").write_text(
        json.dumps(profile, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (settings_root / "user-settings.json").write_text(
        json.dumps(settings, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def sqlite_read_only(path: Path) -> sqlite3.Connection:
    require(path.is_file(), f"运行事实未落盘：{path.name}")
    return sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)


def shell_environment(daemon: OwnedDaemon) -> dict[str, str]:
    environment = os.environ.copy()
    environment["DEEPCODE_HOST_SHELL_TOKEN"] = daemon.token
    environment["DEEPCODE_CLI_RUN_TIMEOUT_MS"] = "15000"
    return environment


def json_payloads(body: dict[str, Any]) -> list[dict[str, Any]]:
    result = []
    for message in body["messages"]:
        try:
            value = json.loads(message.get("content") or "")
            if isinstance(value, dict):
                result.append(value)
        except ValueError:
            pass
    return result


class ProviderState:
    def __init__(self, workspace: Path) -> None:
        self.workspace = workspace
        self.requests: list[dict[str, Any]] = []
        self.responses_requests: list[dict[str, Any]] = []
        self.failure: BaseException | None = None

    def record_failure(self, error: BaseException) -> None:
        self.failure = error

    def assert_healthy(self) -> None:
        if self.failure is not None:
            raise AssertionError(f"Provider fixture assertion: {self.failure}") from self.failure

    def inspect(self, body: dict[str, Any]) -> tuple[int, dict[str, str], dict[str, Any]]:
        self.requests.append(body)
        ordinal = len(self.requests)
        require(body["tools"] == self.requests[0]["tools"], "工具目录在轮次间变化")
        prefix = self.requests[0]["messages"]
        require(body["messages"][:len(prefix)] == prefix, "稳定消息前缀被重写")
        pending: set[str] = set()
        results = {}
        for message in body["messages"]:
            calls = message.get("tool_calls", [])
            if calls:
                require(not pending, "前一批工具调用尚未返回结果")
                pending.update(call["id"] for call in calls)
            elif message["role"] == "tool":
                call_id = message["tool_call_id"]
                require(call_id in pending, "工具结果没有对应调用")
                pending.remove(call_id)
                results[call_id] = json.loads(message["content"])
            else:
                require(not pending, "工具结果之前插入了下一条消息")
        require(not pending, "Provider 收到了缺失工具结果的历史")
        names = {}
        for tool in body["tools"]:
            function = tool["function"]
            properties = function["parameters"].get("properties", {})
            if "path" in properties and "startByte" in properties:
                names["read"] = function["name"]
                require("workspace" not in function["parameters"]["required"], "workspace 缺省未开放")
            elif "edits" in properties:
                names["edit"] = function["name"]
            elif "path" in properties and "content" in properties and "format" not in properties:
                names["write"] = function["name"]
            elif "command" in properties and "timeout" in properties:
                names["bash"] = function["name"]
            elif "mutationManifest" in properties:
                names["plan"] = function["name"]
            elif "items" in properties and "status" in properties["items"].get("items", {}).get("properties", {}):
                names["progress"] = function["name"]
        require({"read", "edit", "write", "bash", "plan", "progress"} <= names.keys(), f"缺少本次工具目录：{names}")
        return ordinal, names, results


def cli(daemon: Any, session_id: str, text: str, expected: int = 0, *, run_timeout_seconds: int = 15) -> subprocess.CompletedProcess[str]:
    environment = shell_environment(daemon)
    environment["DEEPCODE_CLI_RUN_TIMEOUT_MS"] = str(run_timeout_seconds * 1000)
    result = subprocess.run([
        str(CLI_BINARY), "--api", daemon.base_url, "--no-auto-start-kernel",
        "--session", session_id, "--plain", "ask", text,
    ], cwd=ROOT, env=environment, capture_output=True, text=True, encoding='utf-8', timeout=run_timeout_seconds + 30)
    require(result.returncode == expected, f"CLI 退出 {result.returncode}，预期 {expected}\n{result.stdout}\n{result.stderr}")
    return result


class MockProviderHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    @property
    def provider_state(self) -> ProviderState:
        return self.server.provider_state  # type: ignore[attr-defined]

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/fixture-resource":
            encoded = b"web-fetch-ok"
            self.send_response(200)
            self.send_header("content-type", "text/plain; charset=utf-8")
        elif parsed.path == "/search":
            encoded = json.dumps({
                "results": [{
                    "title": "Fixture search result",
                    "url": f"http://127.0.0.1:{self.server.server_port}/fixture-resource",
                    "snippet": "Local deterministic search evidence.",
                }],
            }, separators=(",", ":")).encode("utf-8")
            self.send_response(200)
            self.send_header("content-type", "application/json")
        else:
            self.send_error(404)
            return
        self.send_header("content-length", str(len(encoded)))
        self.send_header("connection", "close")
        self.end_headers()
        self.wfile.write(encoded)
        self.close_connection = True

    def _send_tool_calls(
        self,
        calls: list[tuple[str, str, dict[str, Any]]],
    ) -> None:
        self._send_payload({
            "choices": [{
                "index": 0,
                "delta": {
                    "tool_calls": [{
                        "index": index,
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": json.dumps(arguments, separators=(",", ":")),
                        },
                    } for index, (call_id, name, arguments) in enumerate(calls)],
                },
                "finish_reason": "tool_calls",
            }],
            "usage": provider_usage(),
        })
        self._send_done()

    def _send_text(self, content: str) -> None:
        self._send_payload({
            "choices": [{
                "index": 0,
                "delta": {"content": content},
                "finish_reason": "stop",
            }],
            "usage": provider_usage(),
        })
        self._send_done()

    def _send_payload(self, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        self.wfile.write(f"data: {encoded}\n\n".encode("utf-8"))
        self.wfile.flush()

    def _send_done(self) -> None:
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        self.close_connection = True

    def log_message(self, _format: str, *_args: object) -> None:
        return
