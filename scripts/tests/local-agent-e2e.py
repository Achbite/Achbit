#!/usr/bin/env python3
"""验证本地 fixture Provider、两轮工具调用和共享投影；不承担真实 Provider 或发布验收。"""

from __future__ import annotations

from contextlib import ExitStack, closing
import http.server
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


spec = importlib.util.spec_from_file_location("achbit_test_support", Path(__file__).with_name("support.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)

GENERATION_ONE = "SKILL_GENERATION_ONE"
GENERATION_TWO = "SKILL_GENERATION_TWO"
ATTACHMENT_CONTENT = "LOCAL_ATTACHMENT_CONTENT_MUST_NOT_REACH_PROVIDER"
LONG_INPUT = "  原始任务约束与资料🙂\n" * 4000
PDF_CONTENT = "ACHBIT_FIRST_PARTY_PDF_BINDING_OK"
REQUIRED_CORE_TOOLS = {"fs.read", "web.search", "web.fetch"}
FIRST_PARTY_TOOL_OWNERS = {
    "github.search": "plugin://github@first-party",
    "github.read": "plugin://github@first-party",
    "arxiv.search": "plugin://arxiv@first-party",
    "arxiv.read": "plugin://arxiv@first-party",
    "pdf.read": "plugin://pdf@first-party",
}
FIRST_PARTY_PLUGIN_URIS = set(FIRST_PARTY_TOOL_OWNERS.values())


MCP_SERVER = fixture.ROOT / "fixtures" / "skill-mcp-smoke" / "mcp" / "mcp-text-tools" / "server.py"


class ProviderState:
    """Routes deterministic fixture responses by request order, never by prompt text."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._requests: list[dict[str, Any]] = []
        self.title_requests: list[dict[str, Any]] = []
        self._requests_by_id: dict[str, dict[str, Any]] = {}
        self._failures: list[str] = []
        self._old_wire_name: str | None = None
        self._new_wire_name: str | None = None
        self._daemon: fixture.OwnedDaemon | None = None
        self._session_id: str | None = None
        self.skill_path: Path | None = None
        self._consumed_receipts: set[str] = set()
        self._last_receipt_sequence = 0
        self.first_request_started = threading.Event()
        self.release_first_request = threading.Event()

    def bind_session(self, daemon: fixture.OwnedDaemon, session_id: str) -> None:
        fixture.require(self._daemon is None, "Provider fixture 已绑定 Session")
        self._daemon = daemon
        self._session_id = session_id

    def register(self, body: dict[str, Any]) -> int:
        fixture.require(body.get("stream") is True, "Provider 请求未使用流式链路")
        fixture.require(isinstance(body.get("messages"), list), "Provider 请求缺少 messages")
        fixture.require(isinstance(body.get("tools"), list), "Provider 请求缺少 tools")
        with self._lock:
            self._requests.append(body)
            return len(self._requests)

    def inspect(self, ordinal: int, body: dict[str, Any]) -> dict[str, str]:
        tools_by_name = self.current_receipt_tools(ordinal, body)
        messages = body["messages"]
        joined = "\n".join(
            fixture.message_text(message.get("content"))
            for message in messages
            if isinstance(message, dict)
        )
        system_text = "\n".join(fixture.message_text(message.get("content"))
                                for message in messages if message.get("role") == "system")
        fixture.require(GENERATION_ONE not in system_text and GENERATION_TWO not in system_text,
                        "Skill 正文被自动注入系统上下文，应通过读取工具按需加载")
        mcp_server_id = "fixture-old" if ordinal <= 2 else "fixture-new"
        reverse_tool = tools_by_name.get(f"mcp.{mcp_server_id}.text.reverse")
        fixture.require(isinstance(reverse_tool, dict),
            f"Provider 请求 {ordinal} 缺少 run 已绑定的 MCP reverse 工具：{mcp_server_id}")
        fixture.require(
            reverse_tool.get("origin") == "extension"
            and reverse_tool.get("pluginUri") == f"plugin://{mcp_server_id}@mcp",
            "MCP reverse 工具没有绑定当前 run 的 plugin owner",
        )
        wire_name = reverse_tool["wireName"]
        for name, plugin_uri in FIRST_PARTY_TOOL_OWNERS.items():
            tool = tools_by_name.get(name)
            fixture.require(
                isinstance(tool, dict)
                and tool.get("origin") == "extension"
                and tool.get("pluginUri") == plugin_uri,
                f"Provider 请求缺少精确 first-party 工具与 owner：{name}",
            )
        results = {
            str(message.get("tool_call_id")): fixture.message_text(message.get("content"))
            for message in messages
            if isinstance(message, dict)
            and message.get("role") == "tool"
            and isinstance(message.get("tool_call_id"), str)
        }

        if ordinal == 1:
            fixture.require(GENERATION_ONE not in joined, "未读取的 Skill 正文提前进入首个请求")
            fixture.require(GENERATION_TWO not in joined, "第一轮首个请求提前加载新 Skill generation")
            attachment_messages = [
                fixture.message_text(message.get("content")) for message in messages
                if isinstance(message, dict) and message.get("role") == "user"
                and '"path":"e2e-note.txt"' in fixture.message_text(message.get("content"))
            ]
            fixture.require(len(attachment_messages) == 1, "文件引用逻辑路径未唯一进入首轮用户消息")
            references = json.loads(attachment_messages[0].rsplit("\n", 1)[-1])
            fixture.require(isinstance(references, list) and len(references) == 1, "Provider 文件引用必须唯一")
            attachment_reference = references[0]
            fixture.require(attachment_reference.get("mediaType") == "text/plain", "文件引用 mediaType 未进入首轮请求")
            attachment_workspace = attachment_reference.get("workspace")
            fixture.require(
                isinstance(attachment_workspace, str)
                and (attachment_workspace == "primary" or (
                    attachment_workspace.startswith("workspace") and attachment_workspace[9:].isdigit()
                )),
                "文件引用未使用逻辑 workspace handle",
            )
            fixture.require(ATTACHMENT_CONTENT not in joined, "文件内容被错误嵌入首轮 Provider 请求")
            with self._lock:
                self._old_wire_name = wire_name
            self.first_request_started.set()
        elif ordinal == 2:
            fixture.require(GENERATION_ONE not in joined, "下一请求仍使用旧 Skill 内容")
            fixture.require(GENERATION_TWO in results.get("provider-call-skill-one", ""), "按需读取没有取得已更新 Skill 正文")
            fixture.require(wire_name == self.old_wire_name(), "nextRun MCP 配置提前影响了当前 run")
            settings = fixture.api_json(self._daemon.base_url, "/api/user-settings", token=self._daemon.token)
            fixture.require(settings["runtimeSettings"]["agent.permissions.networkRead"] == "allow", "内容刷新激活了 nextRun 权限")
            fixture.require(
                any("ahpla" in content for content in results.values()),
                "第一轮 MCP ToolRecord 未进入 Provider continuation",
            )
            fixture.require(
                any("Fixture search result" in content for content in results.values()),
                "第一轮 web.search ToolRecord 未进入 Provider continuation",
            )
            fixture.require(
                any("web-fetch-ok" in content for content in results.values()),
                "第一轮 web.fetch ToolRecord 未进入 Provider continuation",
            )
            fixture.require(
                any(ATTACHMENT_CONTENT in content for content in results.values()),
                "第一轮 fs.read 未按逻辑引用惰性读取文件快照",
            )
            fixture.require(
                any(PDF_CONTENT in content for content in results.values()),
                "第一轮 pdf.read 未从 Kernel prepared workspace binding 提取正文",
            )
        elif ordinal == 3:
            fixture.require(LONG_INPUT not in joined, "长文本仍被整篇内联到 Provider 请求")
            fixture.require('"path":"user-input.txt"' in joined, "长文本资源引用未进入当前输入")
            fixture.require(GENERATION_TWO in joined, "下一 run 丢失上一轮 Skill 读取结果")
            fixture.require(GENERATION_ONE not in joined, "下一 run 仍暴露旧 Skill generation")
            fixture.require(wire_name != self.old_wire_name(), "下一 run 未取得新的 MCP wire tool")
            with self._lock:
                self._new_wire_name = wire_name
        elif ordinal == 4:
            fixture.require(GENERATION_TWO in results.get("provider-call-skill-two", ""), "第二轮显式读取未返回当前 Skill 正文")
            fixture.require(GENERATION_ONE not in joined, "第二轮 continuation 混入旧 Skill snapshot")
            fixture.require(wire_name == self.new_wire_name(), "第二轮 continuation 的 MCP 目录漂移")
            fixture.require(
                any("ateb" in content for content in results.values()),
                "第二轮 MCP ToolRecord 未进入 Provider continuation",
            )
            fixture.require(
                any("Fixture search result" in content for content in results.values()),
                "第二轮 web.search ToolRecord 未进入 Provider continuation",
            )
            fixture.require(
                any("web-fetch-ok" in content for content in results.values()),
                "第二轮 web.fetch ToolRecord 未进入 Provider continuation",
            )
        else:
            raise AssertionError(f"Provider 收到未登记的第 {ordinal} 个请求")
        return {
            "read": tools_by_name["fs.read"]["wireName"],
            **({"readWorkspace": attachment_workspace} if ordinal == 1 else {}),
            "reverse": wire_name,
            "pdf": tools_by_name["pdf.read"]["wireName"],
            "search": tools_by_name["web.search"]["wireName"],
            "fetch": tools_by_name["web.fetch"]["wireName"],
        }

    def current_receipt_tools(
        self,
        ordinal: int,
        body: dict[str, Any],
    ) -> dict[str, dict[str, Any]]:
        fixture.require(self._daemon is not None and self._session_id is not None, "Provider fixture 尚未绑定 Session")
        current = fixture.projection(self._daemon, self._session_id)
        run = current.get("run")
        fixture.require(isinstance(run, dict) and run.get("status") == "running", "Provider 请求没有当前 running run")
        receipts = current.get("contextCompositions")
        fixture.require(isinstance(receipts, list), "当前投影缺少 context receipt")
        with self._lock:
            fixture.require(len(self._consumed_receipts) == ordinal - 1, "Provider 请求与 context receipt 消费次序不一致")
            pending = [
                receipt for receipt in receipts
                if isinstance(receipt, dict)
                and receipt.get("runId") == run.get("runId")
                and receipt.get("providerRequestId") not in self._consumed_receipts
            ]
            fixture.require(len(pending) == 1, "当前 run 没有唯一未消费的 context receipt")
            receipt = pending[0]
            request_id = receipt.get("providerRequestId")
            sequence = receipt.get("sequence")
            fixture.require(isinstance(request_id, str) and bool(request_id), "context receipt 缺少 Provider requestId")
            fixture.require(
                isinstance(sequence, int) and sequence > self._last_receipt_sequence,
                "context receipt sequence 没有前进",
            )
            fixture.require(receipt.get("purpose") == "agent", "fixture Provider 请求关联到错误的 context purpose")
            self._consumed_receipts.add(request_id)
            self._requests_by_id[request_id] = body
            self._last_receipt_sequence = sequence

        receipt_tools = receipt.get("tools")
        fixture.require(isinstance(receipt_tools, list) and bool(receipt_tools), "context receipt 工具目录为空")
        tools_by_name: dict[str, dict[str, Any]] = {}
        wire_names: list[str] = []
        for tool in receipt_tools:
            fixture.require(isinstance(tool, dict), "context receipt 工具不是对象")
            canonical_name = tool.get("canonicalName")
            wire_name = tool.get("wireName")
            fixture.require(
                isinstance(canonical_name, str) and bool(canonical_name)
                and isinstance(wire_name, str) and bool(wire_name)
                and canonical_name not in tools_by_name and wire_name not in wire_names
                and tool.get("availability") == "callable",
                "context receipt 的 canonical/wire 映射缺失、重复或不可调用",
            )
            tools_by_name[canonical_name] = tool
            wire_names.append(wire_name)
        provider_wire_names = [
            item.get("function", {}).get("name")
            if isinstance(item, dict) and isinstance(item.get("function"), dict) else None
            for item in body["tools"]
        ]
        fixture.require(provider_wire_names == wire_names, "Provider 请求的工具目录与当前 context receipt 不一致")
        fixture.require(
            REQUIRED_CORE_TOOLS.issubset(tool["canonicalName"] for tool in receipt_tools if tool.get("origin") == "coreBuiltin"),
            "Provider 缺少本场景需要的基础工具",
        )
        return tools_by_name

    def first_started(self) -> bool:
        self.assert_healthy()
        return self.first_request_started.is_set()

    def record_failure(self, error: BaseException) -> None:
        with self._lock:
            self._failures.append(f"{type(error).__name__}: {error}")

    def assert_healthy(self) -> None:
        with self._lock:
            failure = self._failures[0] if self._failures else None
        if failure is not None:
            raise AssertionError(f"Mock Provider 失败：{failure}")

    def count(self) -> int:
        with self._lock:
            return len(self._requests)

    def request_for(self, request_id: str) -> dict[str, Any]:
        with self._lock:
            fixture.require(request_id in self._requests_by_id, f"context receipt 没有对应 Provider 请求：{request_id}")
            return self._requests_by_id[request_id]

    def old_wire_name(self) -> str:
        with self._lock:
            value = self._old_wire_name
        fixture.require(value is not None, "旧 MCP wire name 尚未捕获")
        return value

    def new_wire_name(self) -> str:
        with self._lock:
            value = self._new_wire_name
        fixture.require(value is not None, "新 MCP wire name 尚未捕获")
        return value


class MockProviderHandler(fixture.MockProviderHandler):
    protocol_version = "HTTP/1.1"


    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        headers_sent = False
        try:
            fixture.require(self.path.endswith("/chat/completions"), "Provider endpoint 不匹配")
            fixture.require(self.headers.get("authorization") == "Bearer e2e-key", "Provider 凭据不匹配")
            length = int(self.headers.get("content-length", "0"))
            fixture.require(0 < length <= 8 * 1024 * 1024, "Provider 请求长度无效")
            body = json.loads(self.rfile.read(length))
            fixture.require(isinstance(body, dict), "Provider body 不是对象")
            if self.respond_to_title(body):
                return
            ordinal = self.provider_state.register(body)
            wire_names = self.provider_state.inspect(ordinal, body)

            self.send_response(200)
            self.send_header("content-type", "text/event-stream; charset=utf-8")
            self.send_header("cache-control", "no-cache")
            self.send_header("connection", "close")
            self.end_headers()
            headers_sent = True

            if ordinal == 1:
                fixture.require(
                    self.provider_state.release_first_request.wait(timeout=20),
                    "等待第一轮运行时更新超时",
                )
                self._send_tool_calls([
                    ("provider-call-read-one", wire_names["read"], {
                        "workspace": wire_names["readWorkspace"],
                        "path": "e2e-note.txt",
                    }),
                    ("provider-call-one", wire_names["reverse"], {"text": "alpha"}),
                    ("provider-call-pdf-one", wire_names["pdf"], {
                        "workspace": "primary",
                        "path": "fixture.pdf",
                        "startPage": 1,
                        "endPage": 1,
                    }),
                    ("provider-call-search-one", wire_names["search"], {
                        "query": "fixture",
                        "limit": 1,
                    }),
                    ("provider-call-fetch-one", wire_names["fetch"], {
                        "url": f"http://127.0.0.1:{self.server.server_port}/fixture-resource",
                    }),
                    ("provider-call-skill-one", wire_names["read"], {
                        "workspace": "primary", "path": str(self.provider_state.skill_path),
                    }),
                ])
            elif ordinal == 2:
                self._send_text("round-one-complete")
            elif ordinal == 3:
                self._send_tool_calls([
                    ("provider-call-two", wire_names["reverse"], {"text": "beta"}),
                    ("provider-call-search-two", wire_names["search"], {
                        "query": "fixture",
                        "limit": 1,
                    }),
                    ("provider-call-fetch-two", wire_names["fetch"], {
                        "url": f"http://127.0.0.1:{self.server.server_port}/fixture-resource",
                    }),
                    ("provider-call-skill-two", wire_names["read"], {
                        "workspace": "primary", "path": str(self.provider_state.skill_path),
                    }),
                ])
            elif ordinal == 4:
                self._send_text("round-two-complete")
        except (BrokenPipeError, ConnectionResetError):
            return
        except BaseException as error:
            self.provider_state.record_failure(error)
            if not headers_sent:
                self.send_error(500)
            self.close_connection = True


class MockProviderServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, state: ProviderState) -> None:
        super().__init__(("127.0.0.1", 0), MockProviderHandler)
        self.provider_state = state


def write_pdf_fixture(path: Path, text: str) -> None:
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream = f"BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET\n".encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"
        ),
        b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n"
        + stream + b"endstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    encoded = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, value in enumerate(objects, start=1):
        offsets.append(len(encoded))
        encoded.extend(f"{index} 0 obj\n".encode("ascii"))
        encoded.extend(value)
        encoded.extend(b"\nendobj\n")
    xref_offset = len(encoded)
    encoded.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    encoded.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        encoded.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    encoded.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n"
        ).encode("ascii")
    )
    path.write_bytes(encoded)


def assert_unknown_attachment_fields_rejected(
    daemon: fixture.OwnedDaemon,
    session_id: str,
) -> None:
    path_id = urllib.parse.quote(session_id, safe="")
    envelope = fixture.api_envelope(
        daemon.base_url,
        f"/api/conversation/sessions/{path_id}/commands",
        token=daemon.token,
        method="POST",
        body={
            "schemaVersion": fixture.COMMAND_VERSION,
            "type": "message.submit",
            "commandId": "command-unknown-attachment-fields",
            "sessionId": session_id,
            "text": "unsupported attachment fields",
            "attachments": [],
            "directoryAttachments": [],
        },
        timeout=12,
    )
    fixture.require(envelope.get("ok") is False, "未声明的附件字段被当前 Session wire 合同接受")


def selected_plugin_catalog(daemon: fixture.OwnedDaemon, label: str) -> list[dict[str, Any]]:
    catalog = fixture.api_json(
        daemon.base_url,
        "/api/conversation/plugins",
        token=daemon.token,
    )
    fixture.require(isinstance(catalog, dict), f"{label} PluginCatalogProjection 不是对象")
    revision = catalog.get("revision")
    plugins = catalog.get("plugins")
    fixture.require(isinstance(revision, str) and revision, f"{label} 插件目录 revision 无效")
    fixture.require(isinstance(plugins, list), f"{label} 插件目录不是数组")
    typed_plugins = [plugin for plugin in plugins if isinstance(plugin, dict)]
    fixture.require(len(typed_plugins) == len(plugins), f"{label} 插件目录项不是对象")
    uris = {plugin.get("uri") for plugin in typed_plugins}
    fixture.require(FIRST_PARTY_PLUGIN_URIS.issubset(uris), f"{label} 缺少 first-party 插件")
    # Select this scenario's plugins without fixing the size of the extensible catalog.
    selected_plugins = [
        plugin for plugin in typed_plugins
        if isinstance(plugin.get("uri"), str)
        and (plugin["uri"] in FIRST_PARTY_PLUGIN_URIS or plugin["uri"].endswith(("@skill", "@mcp")))
    ]
    fixture.require(
        len(selected_plugins) == 5
        and len([uri for uri in uris if isinstance(uri, str) and uri.endswith("@skill")]) == 1
        and len([uri for uri in uris if isinstance(uri, str) and uri.endswith("@mcp")]) == 1,
        f"{label} 必须选中三项 first-party 插件及当前 Skill/MCP fixture",
    )
    return selected_plugins


def submit_message(
    daemon: fixture.OwnedDaemon,
    session_id: str,
    command_id: str,
    text: str,
    filesystem_references: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    plugins = selected_plugin_catalog(daemon, "message.submit")
    selections = []
    for index, plugin in enumerate(plugins):
        fixture.require(isinstance(plugin, dict), "插件目录项不是对象")
        uri = plugin.get("uri")
        label = plugin.get("displayName")
        fixture.require(isinstance(uri, str) and uri.startswith("plugin://"), "插件 URI 无效")
        fixture.require(isinstance(label, str) and label, "插件 label 无效")
        selections.append({
            "selectionId": f"{command_id}:plugin:{index + 1}",
            "uri": uri,
            "label": label,
        })
    path_id = urllib.parse.quote(session_id, safe="")
    value = fixture.api_json(
        daemon.base_url,
        f"/api/conversation/sessions/{path_id}/commands",
        token=daemon.token,
        method="POST",
        body={
            "schemaVersion": fixture.COMMAND_VERSION,
            "type": "message.submit",
            "commandId": command_id,
            "sessionId": session_id,
            "text": text,
            **({"filesystemReferences": filesystem_references} if filesystem_references else {}),
            "pluginSelections": selections,
        },
        timeout=15,
    )
    fixture.require(isinstance(value, dict), "command reply 不是对象")
    fixture.require(value.get("status") == "accepted", "Session 未接纳 message.submit")
    return value


def start_cli_ask_with_file(
    daemon: fixture.OwnedDaemon,
    session_id: str,
    file_path: Path,
    text: str,
) -> subprocess.Popen[str]:
    plugins = selected_plugin_catalog(daemon, "CLI ask")
    command = [
        str(fixture.CLI_BINARY),
        "--api", daemon.base_url,
        "--no-auto-start-kernel",
        "--session", session_id,
        "--file", str(file_path),
        "--plain",
    ]
    for plugin in plugins:
        uri = plugin.get("uri") if isinstance(plugin, dict) else None
        fixture.require(isinstance(uri, str) and uri.startswith("plugin://"), "CLI ask 插件 URI 无效")
        command.extend(["--plugin", uri])
    command.extend(["ask", text])
    return subprocess.Popen(
        command,
        cwd=fixture.ROOT,
        env=fixture.shell_environment(daemon),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def plugin_settings(
    skill_root: Path,
    mount_id: str,
    server_id: str,
    server_name: str,
) -> dict[str, Any]:
    return {
        "skills.autoLoad": True,
        "skills.mounts": json.dumps([{
            "id": mount_id,
            "path": str(skill_root),
            "enabled": True,
        }], separators=(",", ":")),
        "mcp.autoLoad": True,
        "mcp.servers": json.dumps([{
            "id": server_id,
            "name": server_name,
            "transport": "stdio",
            "command": sys.executable,
            "args": str(MCP_SERVER),
            "enabled": True,
        }], separators=(",", ":")),
    }


def patch_plugins(
    daemon: fixture.OwnedDaemon,
    old_settings: dict[str, Any],
    new_settings: dict[str, Any],
) -> None:
    changed = {key: new_settings[key] for key in new_settings if new_settings[key] != old_settings[key]}
    result = fixture.api_json(
        daemon.base_url,
        "/api/user-settings",
        token=daemon.token,
        method="PATCH",
        body={"patches": changed},
    )
    fixture.require(result.get("activation") == "nextRun", "插件设置未声明 nextRun 激活")
    fixture.require(set(result.get("changedKeys", [])) == set(changed), "插件设置变更键不完整")

    snapshot = fixture.api_json(daemon.base_url, "/api/user-settings", token=daemon.token)
    for key in changed:
        fixture.require(snapshot["settings"].get(key) == new_settings[key], f"{key} 未写入保存设置")
        fixture.require(
            snapshot["runtimeSettings"].get(key) == old_settings[key],
            f"{key} 在当前 run 内提前激活",
        )


def assert_runtime_activated(daemon: fixture.OwnedDaemon, new_settings: dict[str, Any]) -> None:
    snapshot = fixture.api_json(daemon.base_url, "/api/user-settings", token=daemon.token)
    for key in ("skills.mounts", "mcp.servers"):
        fixture.require(
            snapshot["runtimeSettings"].get(key) == new_settings[key],
            f"{key} 未在下一 run 激活",
        )


def assert_projection_flow(value: dict[str, Any]) -> None:
    run = value.get("run") or {}
    fixture.require(run.get("status") == "completed", "最终 run 未完成")
    assistant_messages = [
        message for message in value.get("messages", []) if message.get("role") == "assistant"
    ]
    fixture.require(len(assistant_messages) == 2, "两轮基础链路没有形成两个 assistant 事实")
    fixture.require(assistant_messages[-1].get("content") == "round-two-complete", "最终消息数据流错误")
    completed_tools = [
        activity
        for activity in value.get("activities", [])
        if activity.get("kind") == "tool" and activity.get("status") == "completed"
    ]
    fixture.require(
        len(completed_tools) == 10,
        "两轮附件/Skill 读取/MCP/PDF/web 调用未形成十个 completed activity",
    )

    usage = value.get("tokenUsage") or {}
    fixture.require(usage.get("providerCallCount") == 4, "Provider 调用聚合错误")
    fixture.require(usage.get("reportedCallCount") == 4, "缓存报告调用聚合错误")
    fixture.require(usage.get("inputTokens") == 400, "输入 token 聚合错误")
    fixture.require(usage.get("outputTokens") == 40, "输出 token 聚合错误")
    fixture.require(usage.get("cacheReadInputTokens") == 160, "缓存读取 token 聚合错误")
    fixture.require(usage.get("cacheMissInputTokens") == 240, "缓存未命中 token 聚合错误")
    fixture.require(usage.get("cacheAvailable") is True, "缓存事实未标记 available")
    fixture.require(usage.get("cacheComplete") is True, "缓存事实未标记 complete")
    ratio = usage.get("cacheHitRatio")
    fixture.require(isinstance(ratio, (int, float)) and abs(ratio - 0.4) < 1e-12, "缓存命中率分母错误")


def assert_received_tool_guidance(body: dict[str, Any], receipt: dict[str, Any], runtime: dict[str, Any]) -> None:
    contributions = {item["canonicalToolName"]: item for item in runtime["toolPromptContributions"]}
    required = REQUIRED_CORE_TOOLS | {"bash"} | set(FIRST_PARTY_TOOL_OWNERS)
    fixture.require(required.issubset(contributions), "必要工具缺少生产端 tool prompt contribution")
    aliases = {item["canonicalName"]: item["wireName"] for item in receipt["tools"]}
    definitions = {item["function"]["name"]: item["function"] for item in body["tools"]}
    system_messages = [fixture.message_text(message.get("content")) for message in body["messages"]
                       if isinstance(message, dict) and message.get("role") == "system"]
    for name in required:
        contribution = contributions[name]
        parts = ([contribution["promptSnippet"]] if contribution.get("promptSnippet") else [])
        parts.extend(contribution["usageGuidelines"])
        fixture.require(parts and all(isinstance(part, str) and part.strip() for part in parts),
                        f"必要工具的生产提示为空：{name}")
        fixture.require(name in aliases, f"必要工具没有当前 Provider alias：{name}")
        wire_name = aliases[name]
        fixture.require(wire_name in definitions, f"当前 Provider 请求缺少对应工具定义：{name}")
        # Descriptions already travel with tool definitions; system guidance
        # carries additional instructions without having to duplicate them.
        received_guidance = [definitions[wire_name].get("description", "")]
        received_guidance.extend(message for message in system_messages if wire_name in message)
        fixture.require(all(any(part in text for text in received_guidance) for part in parts),
                        f"生产端工具提示未完整进入当前 Provider 请求：{name}")


def assert_persisted_tool_bindings_and_release(config_root: Path, session_id: str, provider: ProviderState) -> None:
    runtime_root = config_root / "data" / "agent-runtime"
    with closing(fixture.sqlite_read_only(runtime_root / "session.sqlite3")) as connection:
        started_rows = connection.execute(
            "SELECT run_id, payload_json FROM session_events "
            "WHERE session_id=? AND event_type='run.started' ORDER BY sequence",
            (session_id,),
        ).fetchall()
        lifecycle_rows = connection.execute(
            "SELECT run_id, event_type, sequence, payload_json FROM session_events "
            "WHERE session_id=? AND event_type IN "
            "('tool.completed','context.composed','run.tools.prepared','run.finishing','run.runtime.released',"
            "'run.runtime.release_failed','run.settled') ORDER BY sequence",
            (session_id,),
        ).fetchall()
    fixture.require(len(started_rows) == 2, "两轮链路没有两个 run.started runtime snapshot")

    with closing(fixture.sqlite_read_only(runtime_root / "tool-record.sqlite3")) as connection:
        record_rows = connection.execute(
            "SELECT run_id, call_id, record_json FROM tool_records "
            "WHERE session_id=? ORDER BY completed_at, call_id",
            (session_id,),
        ).fetchall()
    fixture.require(len(record_rows) == 10, "两轮链路没有十个附件/Skill 读取/MCP/PDF/web ToolRecord")
    records_by_run: dict[str, list[tuple[str, dict[str, Any]]]] = {}
    for run_id, call_id, encoded in record_rows:
        records_by_run.setdefault(run_id, []).append((call_id, json.loads(encoded)))

    lifecycle_by_run: dict[str, list[tuple[str, int, dict[str, Any]]]] = {}
    for run_id, event_type, sequence, encoded in lifecycle_rows:
        lifecycle_by_run.setdefault(run_id, []).append((event_type, sequence, json.loads(encoded)))

    snapshots: list[dict[str, Any]] = []
    plugin_instances: list[str] = []
    expected_io = [("alpha", "ahpla"), ("beta", "ateb")]
    for run_index, ((run_id, encoded), (expected_input, expected_output)) in enumerate(
        zip(started_rows, expected_io)
    ):
        payload = json.loads(encoded)
        runtime = payload.get("runtimeSnapshot")
        fixture.require(isinstance(runtime, dict), "run.started 缺少 runtimeSnapshot")
        initial_catalog_ref = runtime["kernelCatalogSnapshotRef"]
        lifecycle = lifecycle_by_run.get(run_id, [])
        views = {runtime["kernelCatalogSnapshotRef"]: runtime}
        active_view = runtime
        for event_type, _, event_payload in lifecycle:
            if event_type == "run.tools.prepared":
                active_view = {**runtime, **event_payload["toolView"]}
                views[active_view["kernelCatalogSnapshotRef"]] = active_view
        receipts = [event_payload for event_type, _, event_payload in lifecycle if event_type == "context.composed"]
        fixture.require(len(receipts) == 2, "每个 run 必须有 tool turn 与 continuation 两个 context receipt")
        fixture.require(all(receipt.get("kernelCatalogSnapshotRef") in views for receipt in receipts),
            "context receipt 未引用已记录的工具视图")
        runtime = views[receipts[0]["kernelCatalogSnapshotRef"]]
        workspace_bindings = payload.get("workspaceBindings")
        fixture.require(isinstance(workspace_bindings, list) and workspace_bindings, "run.started 缺少 workspace bindings")
        primary_workspace_id = workspace_bindings[0].get("workspaceId")
        fixture.require(isinstance(primary_workspace_id, str) and primary_workspace_id, "primary workspaceId 无效")
        runtime_tools = runtime.get("tools", [])
        fixture.require(isinstance(runtime_tools, list), "run runtime tools 不是数组")
        runtime_core_tools = [
            tool for tool in runtime_tools
            if isinstance(tool, dict) and tool.get("origin") == "coreBuiltin"
        ]
        fixture.require(
            REQUIRED_CORE_TOOLS.issubset(tool.get("name") for tool in runtime_core_tools),
            "Kernel runtime snapshot 缺少本场景需要的基础工具",
        )
        runtime_tools_by_name = {
            tool.get("name"): tool for tool in runtime_tools if isinstance(tool, dict)
        }
        prompt_contributions = runtime.get("toolPromptContributions")
        fixture.require(isinstance(prompt_contributions, list), "run runtime 缺少 tool prompt snapshot")
        for contribution in prompt_contributions:
            tool_name = contribution.get("canonicalToolName")
            target = runtime_tools_by_name.get(tool_name)
            fixture.require(isinstance(target, dict), "tool prompt 指向不存在的 runtime tool")
            if target.get("origin") == "coreBuiltin":
                fixture.require(contribution.get("origin") == "coreBuiltin", "core tool prompt origin 漂移")
                fixture.require("pluginUri" not in contribution, "core tool prompt 错误携带 pluginUri")
            else:
                fixture.require(contribution.get("origin") == "extension", "first-party prompt origin 漂移")
                fixture.require(
                    contribution.get("pluginUri") in FIRST_PARTY_PLUGIN_URIS,
                    "first-party prompt 缺少精确 pluginUri",
                )
            fixture.require(
                contribution.get("preparedToolBindingRef") == target.get("toolBindingRef"),
                "tool prompt 没有绑定当前 run 的 prepared tool",
            )
        mcp_server_id = "fixture-old" if run_index == 0 else "fixture-new"
        reverse_tools = [
            tool
            for tool in runtime_tools
            if isinstance(tool, dict) and tool.get("name") == f"mcp.{mcp_server_id}.text.reverse"
        ]
        fixture.require(len(reverse_tools) == 1, "run snapshot 缺少唯一 MCP 工具 binding")
        tool = reverse_tools[0]
        fixture.require(tool.get("origin") == "extension", "MCP prepared tool 缺少 extension origin")
        fixture.require(
            tool.get("pluginUri") == f"plugin://{mcp_server_id}@mcp",
            "MCP prepared tool 缺少精确 pluginUri",
        )
        run_records = records_by_run.get(run_id, [])
        expected_record_count = 6 if run_index == 0 else 4
        fixture.require(
            len(run_records) == expected_record_count,
            f"当前 run 没有精确 {expected_record_count} 个 ToolRecord",
        )
        mcp_records = [entry for entry in run_records if entry[1].get("toolName") == tool.get("name")]
        fixture.require(len(mcp_records) == 1, "MCP ToolRecord 未唯一关联到 runtime tool")
        call_id, record = mcp_records[0]
        fixture.require(record.get("callId") == call_id, "ToolRecord callId 列与事实不一致")
        fixture.require(record.get("outcome") == "completed", "MCP ToolRecord 未完成")
        fixture.require(record.get("input", {}).get("text") == expected_input, "MCP 输入事实错误")
        fixture.require(expected_output in json.dumps(record.get("output"), ensure_ascii=False), "MCP 输出事实错误")
        fixture.require(
            record.get("extensionGenerationRef") == runtime.get("extensionGenerationRef"),
            "ToolRecord 与发起请求时的 ExtensionGenerationRef 不一致",
        )
        fixture.require(
            record.get("kernelCatalogSnapshotRef") == runtime.get("kernelCatalogSnapshotRef"),
            "ToolRecord 与发起请求时的 KernelCatalogSnapshotRef 不一致",
        )
        fixture.require(record.get("toolBindingRef") == tool.get("toolBindingRef"), "ToolBindingRef 未贯通")
        fixture.require(record.get("toolName") == tool.get("name"), "ToolRecord 工具名未贯通")
        prepared = record.get("preparedEffect") or {}
        fixture.require(prepared.get("origin") == "extension", "MCP 工具未标记为 extension contribution")
        fixture.require(prepared.get("toolBindingRef") == tool.get("toolBindingRef"), "PreparedEffect binding 漂移")
        plugin_instance = prepared.get("pluginInstanceRef")
        fixture.require(isinstance(plugin_instance, str) and plugin_instance, "MCP 缺少 PluginInstanceRef")
        plugin_instances.append(plugin_instance)
        web_records = {candidate.get("toolName"): candidate for _, candidate in run_records}
        if run_index == 0:
            pdf_tool = runtime_tools_by_name.get("pdf.read")
            fixture.require(isinstance(pdf_tool, dict), "run snapshot 缺少 pdf.read")
            fixture.require(pdf_tool.get("possibleEffects") == ["workspaceRead"], "pdf.read effect scope 错误")
            fixture.require(pdf_tool.get("pluginUri") == "plugin://pdf@first-party", "pdf.read plugin owner 错误")
            pdf_record = web_records.get("pdf.read")
            fixture.require(isinstance(pdf_record, dict), "第一轮缺少 pdf.read ToolRecord")
            fixture.require(pdf_record.get("outcome") == "completed", "pdf.read ToolRecord 未完成")
            fixture.require(pdf_record.get("input", {}).get("path") == "fixture.pdf", "pdf.read 输入路径漂移")
            fixture.require(
                PDF_CONTENT in json.dumps(pdf_record.get("output"), ensure_ascii=False),
                "pdf.read ToolRecord 未包含真实提取正文",
            )
            pdf_effect = pdf_record.get("preparedEffect") or {}
            fixture.require(pdf_effect.get("workspaceId") == primary_workspace_id, "pdf.read workspace binding 错误")
            fixture.require(pdf_effect.get("logicalTargets") == ["fixture.pdf"], "pdf.read logical target 漂移")
        fixture.require("Fixture search result" in json.dumps(
            web_records["web.search"].get("output"), ensure_ascii=False,
        ), "web.search 没有真实返回结构化结果")
        fixture.require("web-fetch-ok" in json.dumps(
            web_records["web.fetch"].get("output"), ensure_ascii=False,
        ), "web.fetch 没有真实获取 HTTP 内容")
        skill_records = [record for _, record in run_records
                         if record.get("toolName") == "fs.read"
                         and record.get("input", {}).get("path") == str(provider.skill_path)]
        fixture.require(len(skill_records) == 1 and skill_records[0].get("outcome") == "completed",
                        "当前 run 必须恰好完成一次真实 Skill 文件读取")
        fixture.require(GENERATION_TWO in json.dumps(skill_records[0].get("output")),
                        "Skill ToolRecord 未保存实际更新后的正文")
        if run_index == 0:
            attachment_records = [record for _, record in run_records
                                  if record.get("toolName") == "fs.read"
                                  and record.get("input", {}).get("path") == "e2e-note.txt"]
            fixture.require(len(attachment_records) == 1 and ATTACHMENT_CONTENT in json.dumps(
                attachment_records[0].get("output"), ensure_ascii=False),
                "fs.read 没有从 Host 文件快照唯一返回附件原文")

        event_types = [event_type for event_type, _, _ in lifecycle]
        fixture.require("run.runtime.release_failed" not in event_types, "run runtime release 失败")
        for event_type in ("run.finishing", "run.runtime.released", "run.settled"):
            fixture.require(event_types.count(event_type) == 1, f"{event_type} 回执数量错误")
        positions = {event_type: sequence for event_type, sequence, _ in lifecycle}
        fixture.require(
            positions["run.finishing"] < positions["run.runtime.released"] < positions["run.settled"],
            "run release receipt 没有位于 finishing 与 settled 之间",
        )
        released_payload = next(
            event_payload for event_type, _, event_payload in lifecycle
            if event_type == "run.runtime.released"
        )
        # The initial catalog can retire at a request boundary after a tool-view
        # refresh. Final run cleanup still drains its jobs and releases the run.
        fixture.require(isinstance(released_payload.get("alreadyReleased"), bool), "release 缺少 catalog 释放状态")
        fixture.require(released_payload.get("kernelCatalogSnapshotRef") == initial_catalog_ref,
                        "release receipt 没有对应当前 run 的初始 catalog binding")
        fixture.require(
            sorted(released_payload.get("pluginInstanceRefs", [])) == sorted(plugin["pluginInstanceRef"] for plugin in active_view["selectedPlugins"]["plugins"]),
            "release receipt 必须恰好结束本次选中的插件实例",
        )
        completed_order = [
            event_payload.get("record", {}).get("toolName")
            for event_type, _, event_payload in lifecycle
            if event_type == "tool.completed"
        ]
        expected_completed_order = (
            ["fs.read", tool.get("name"), "pdf.read", "web.search", "web.fetch", "fs.read"]
            if run_index == 0
            else [tool.get("name"), "web.search", "web.fetch", "fs.read"]
        )
        fixture.require(completed_order == expected_completed_order, "同一 Provider turn 的工具没有严格按请求顺序完成")
        for receipt in receipts:
            fixture.require(
                isinstance(receipt.get("dynamicInstructionBytes"), int)
                and receipt["dynamicInstructionBytes"] > 0,
                "context.composed dynamicInstructionBytes 无效",
            )
            provider_tools = receipt.get("tools")
            fixture.require(isinstance(provider_tools, list) and provider_tools, "context receipt 工具目录为空")
            fixture.require(all(
                isinstance(item, dict)
                and isinstance(item.get("canonicalName"), str)
                and isinstance(item.get("wireName"), str)
                and item.get("origin") in {"coreBuiltin", "extension", "sessionControl"}
                and item.get("availability") == "callable"
                for item in provider_tools
            ), "context receipt 工具来源字段不完整")
            assert_received_tool_guidance(provider.request_for(receipt["providerRequestId"]), receipt,
                                          views[receipt["kernelCatalogSnapshotRef"]])
        snapshots.append(runtime)

    for key in (
        "runRuntimeSnapshotRef",
        "extensionGenerationRef",
        "kernelCatalogSnapshotRef",
    ):
        fixture.require(snapshots[0].get(key) != snapshots[1].get(key), f"下一 run 未更新 {key}")
    fixture.require(snapshots[0]["tools"] != snapshots[1]["tools"], "下一 run 的工具 snapshot 未更新")
    prompt_bindings = [
        [item.get("preparedToolBindingRef") for item in snapshot["toolPromptContributions"]]
        for snapshot in snapshots
    ]
    fixture.require(prompt_bindings[0] != prompt_bindings[1], "下一 run 未重新绑定 tool prompt snapshot")
    prompt_content = [[
        {key: value for key, value in item.items() if key != "preparedToolBindingRef"}
        for item in snapshot["toolPromptContributions"]
    ] for snapshot in snapshots]
    fixture.require(prompt_content[0] == prompt_content[1], "稳定 core tool guidance 文本发生漂移")
    fixture.require(plugin_instances[0] != plugin_instances[1], "两代 MCP 复用了 PluginInstanceRef")


def assert_shells_read_projection(
    daemon: fixture.OwnedDaemon,
    session_id: str,
    revision: int,
) -> None:
    fixture.require(fixture.CLI_BINARY.is_file(), f"缺少 CLI：{fixture.CLI_BINARY}")
    cli = subprocess.run(
        [
            str(fixture.CLI_BINARY),
            "--api", daemon.base_url,
            "--no-auto-start-kernel",
            "--session", session_id,
            "show",
        ],
        cwd=fixture.ROOT,
        env=fixture.shell_environment(daemon),
        check=False,
        capture_output=True,
        text=True,
        timeout=18,
    )
    fixture.require(cli.returncode == 0, f"CLI 读取共享投影失败：{cli.stderr}")
    fixture.require(
        f"session={session_id} revision={revision}" in f"{cli.stdout}\n{cli.stderr}",
        "CLI 没有读取精确 SessionProjection identity",
    )

    fixture.require(fixture.TUI_BINARY.is_file(), f"缺少 TUI：{fixture.TUI_BINARY}")
    tui = subprocess.run(
        [
            str(fixture.TUI_BINARY),
            "--api", daemon.base_url,
            "--no-auto-start-kernel",
            "--session", session_id,
            "--smoke",
        ],
        cwd=fixture.ROOT,
        env=fixture.shell_environment(daemon),
        check=False,
        capture_output=True,
        text=True,
        timeout=18,
    )
    fixture.require(tui.returncode == 0, f"TUI 读取共享投影失败：{tui.stderr}")
    fixture.require(
        f"session={session_id} revision={revision}" in tui.stdout,
        "TUI 没有读取精确 SessionProjection identity",
    )

    # Ordinary launchers supply the config root, not process-private credentials.
    # Both shells must discover and authenticate the exact existing Host.
    discovered_environment = os.environ.copy()
    for key in ("ACHBIT_API_URL", "ACHBIT_PORT", "ACHBIT_HOST_SHELL_TOKEN", "ACHBIT_HOST_INSTANCE_ID"):
        discovered_environment.pop(key, None)
    discovered_environment["ACHBIT_USER_ROOT"] = str(daemon.config_root)
    for binary, action in ((fixture.TUI_BINARY, "--smoke"), (fixture.CLI_BINARY, "show")):
        attached = subprocess.run(
            [str(binary), "--no-auto-start-kernel", "--session", session_id, action],
            cwd=fixture.ROOT, env=discovered_environment, check=False,
            capture_output=True, text=True, timeout=18,
        )
        fixture.require(attached.returncode == 0, f"{binary.name} 共享连接失败：{attached.stderr}")
        fixture.require(
            f"session={session_id} revision={revision}" in f"{attached.stdout}\n{attached.stderr}",
            f"{binary.name} 自动发现后未读取原 Session",
        )
        fixture.require(daemon.process is not None and daemon.process.poll() is None, "壳退出后错误地停止了共享 Host")
        fixture.require(fixture.api_json(daemon.base_url, "/api/host/identity") == daemon.identity, "壳连接时替换了 Host 实例")


def assert_provider_count_stable(provider: ProviderState, expected: int) -> None:
    deadline = time.monotonic() + 0.35
    while time.monotonic() < deadline:
        provider.assert_healthy()
        fixture.require(provider.count() == expected, "恢复 settled Session 时重复调用 Provider")
        time.sleep(0.05)


def main() -> None:
    fixture.require(MCP_SERVER.is_file(), f"缺少 MCP fixture：{MCP_SERVER}")
    provider = ProviderState()
    provider_server = MockProviderServer(provider)
    provider_thread = threading.Thread(target=provider_server.serve_forever, daemon=True)
    provider_thread.start()
    daemon_one: fixture.OwnedDaemon | None = None
    daemon_two: fixture.OwnedDaemon | None = None
    cli_ask: subprocess.Popen[str] | None = None
    with ExitStack() as storage:
        try:
            temporary = storage.enter_context(tempfile.TemporaryDirectory(prefix="achbit-basic-loop-e2e-"))
            root = Path(temporary)
            config_root = root / "config-root"
            workspace_root = root / "workspace"
            skill_root = root / "runtime-skill"
            config_root.mkdir()
            workspace_root.mkdir()
            skill_root.mkdir()
            write_pdf_fixture(workspace_root / "fixture.pdf", PDF_CONTENT)
            attachment_file = root / "e2e-note.txt"
            attachment_file.write_text(ATTACHMENT_CONTENT, encoding="utf-8")
            skill_file = skill_root / "SKILL.md"
            skill_file.write_text(f"# Runtime fixture\n\n{GENERATION_ONE}\n", encoding="utf-8")

            old_plugins = plugin_settings(
                skill_root,
                "fixture-skill-old",
                "fixture-old",
                "Fixture Old",
            )
            new_plugins = plugin_settings(
                skill_root,
                "fixture-skill-new",
                "fixture-new",
                "Fixture New",
            )
            provider_url = f"http://127.0.0.1:{provider_server.server_port}/v1"
            user_settings = {
                "workbench.language": "en-US",
                "agent.systemPrompt": "",
                "agent.permissions.workspaceMutation": "plan",
                "agent.permissions.engineeringDecisions": "ask",
                "agent.permissions.networkRead": "allow",
                "agent.permissions.external": "allow",
                "agent.web.search.endpointTemplate": (
                    f"http://127.0.0.1:{provider_server.server_port}/search"
                    "?q={query}&limit={limit}"
                ),
                **old_plugins,
            }
            fixture.write_configuration(config_root, provider_url, user_settings)

            daemon_one = fixture.OwnedDaemon(config_root)
            daemon_one.start()
            created = fixture.create_session(daemon_one, workspace_root)
            session_id = created["sessionId"]
            provider.bind_session(daemon_one, session_id)
            provider.skill_path = skill_file
            creation_bindings = created.get("workspaceBindings")
            fixture.require(
                isinstance(creation_bindings, list) and len(creation_bindings) == 1,
                "新项目 Session 没有原子绑定唯一 workspace creation snapshot",
            )
            assert_unknown_attachment_fields_rejected(daemon_one, session_id)
            fixture.require(provider.count() == 0, "未声明附件字段的命令在拒绝前错误启动了 Provider")
            cli_ask = start_cli_ask_with_file(
                daemon_one,
                session_id,
                attachment_file,
                "第一轮链路输入。",
            )

            def first_provider_request_started() -> bool:
                provider.assert_healthy()
                if cli_ask is not None and cli_ask.poll() is not None:
                    cli_stdout, cli_stderr = cli_ask.communicate()
                    raise AssertionError(
                        "CLI 在首个 Provider 请求前退出"
                        f" code={cli_ask.returncode}"
                        f"\nstdout:\n{cli_stdout}"
                        f"\nstderr:\n{cli_stderr}"
                        f"\ndaemon:\n{daemon_one.log_tail()}"
                    )
                if daemon_one.process is not None and daemon_one.process.poll() is not None:
                    raise AssertionError(
                        "Daemon 在首个 Provider 请求前退出"
                        f" code={daemon_one.process.returncode}"
                        f"\n{daemon_one.log_tail()}"
                    )
                return provider.first_started()

            fixture.wait_until(
                first_provider_request_started,
                12,
                "第一轮 Provider 请求未开始",
            )

            skill_file.write_text(f"# Runtime fixture\n\n{GENERATION_TWO}\n", encoding="utf-8")
            patch_plugins(daemon_one,
                {**old_plugins, "agent.permissions.networkRead": "allow"},
                {**new_plugins, "agent.permissions.networkRead": "deny"})
            provider.release_first_request.set()

            def first_file_read_waiting() -> dict[str, Any] | None:
                provider.assert_healthy()
                current = fixture.projection(daemon_one, session_id)
                run = current.get("run") or {}
                fixture.require(run.get("status") not in {"failed", "cancelled", "indeterminate", "releaseFailed"},
                                f"首个附件读取在批准前终止：{current.get('terminalError')}")
                return current if run.get("status") == "waiting" and current.get("pendingApproval") else None

            waiting = fixture.wait_until(first_file_read_waiting, 20, "首个外部附件读取没有等待明确批准")
            approval = waiting["pendingApproval"]
            preview = approval["preview"]
            operation = preview.get("operation") or {}
            arguments = operation.get("arguments") or {}
            fixture.require(waiting.get("pendingApprovals") == [approval], "出现未登记的其他待审批请求")
            fixture.require(operation.get("toolName") == "fs.read" and arguments.get("path") == attachment_file.name,
                            "首个审批不是预期的附件读取")
            fixture.require((Path(operation.get("workspaceRoot", "")) / arguments["path"]).resolve() == attachment_file.resolve(),
                            "附件读取审批没有指向原始文件")
            fixture.require(preview.get("fileAccess") == {"read": [str(attachment_file.resolve())], "write": []},
                            "附件审批超出精确的原文件读取范围")
            first_tool = next(activity for activity in waiting["activities"] if activity.get("kind") == "tool")
            fixture.require(first_tool["callId"] == approval["callId"] and provider.count() == 1,
                            "附件读取审批没有对应首个 Provider 请求的第一个工具")
            cli_stdout, cli_stderr = cli_ask.communicate(timeout=18)
            fixture.require(cli_ask.returncode == 5, f"CLI ask --file 未返回待审批状态：{cli_stdout}\n{cli_stderr}")
            cli_ask = None
            approved = fixture.cli(daemon_one, session_id, "/reply 1")
            first = fixture.wait_completed(daemon_one, provider, session_id, "first run completed")
            fixture.require("round-one-complete" in approved.stdout, "CLI 批准附件读取后未显示第一轮回答")
            fixture.require(first.get("messages", [])[-1].get("content") == "round-one-complete", "第一轮回答未贯通")
            first_input = first.get("messages", [])[0]
            filesystem_references = first_input.get("filesystemReferences")
            fixture.require(isinstance(filesystem_references, list) and len(filesystem_references) == 1, "Host 未返回唯一文件引用")
            fixture.require(filesystem_references[0].get("logicalPath") == "e2e-note.txt", "逻辑文件名漂移")
            fixture.require(filesystem_references[0].get("mediaType") == "text/plain", "文本媒体类型漂移")
            fixture.require(
                set(filesystem_references[0]) == {
                    "referenceId", "workspaceId", "logicalPath", "displayName", "kind",
                    "mediaType", "byteLength",
                },
                "共享 SessionProjection 的文件引用字段不精确",
            )

            # The second run still exercises the existing real web tool coverage.
            fixture.api_json(daemon_one.base_url, "/api/user-settings", token=daemon_one.token,
                method="PATCH", body={"patches": {"agent.permissions.networkRead": "allow"}})
            input_path = f"/api/conversation/sessions/{urllib.parse.quote(session_id, safe='')}/input-resources/command-round-two"
            upload = urllib.request.Request(daemon_one.base_url + input_path, method="POST",
                data=LONG_INPUT.encode("utf-8"), headers={fixture.HOST_TOKEN_HEADER: daemon_one.token, "content-type": "text/plain; charset=utf-8"})
            with fixture.URL_OPENER.open(upload, timeout=10) as response:
                saved = json.loads(response.read())
            fixture.require(saved.get("ok") is True, "长文本原文保存失败")
            reference = saved["data"]["reference"]
            unbound = fixture.api_envelope(daemon_one.base_url,
                f"/api/conversation/sessions/{urllib.parse.quote(session_id, safe='')}/resources/read",
                token=daemon_one.token, method="POST",
                body={"workspaceId": reference["workspaceId"], "logicalPath": reference["logicalPath"]})
            fixture.require(unbound.get("ok") is False, "未接纳输入的暂存资源提前成为会话可读事实")
            # Reusing the same command identity with the complete text must retain
            # exactly the same saved original before Session admission.
            submit_message(daemon_one, session_id, "command-round-two", LONG_INPUT)
            final = fixture.wait_completed(daemon_one, provider, session_id, "second run completed")
            provider.assert_healthy()
            fixture.require(provider.count() == 4, "两轮 tool/continuation Provider 调用数不是四次")
            fixture.require(provider.old_wire_name() != provider.new_wire_name(), "MCP wire tool 未热更新")
            assert_runtime_activated(daemon_one, new_plugins)
            assert_projection_flow(final)
            final_revision = int(final["revision"])

            daemon_one.shutdown()
            assert_persisted_tool_bindings_and_release(config_root, session_id, provider)

            daemon_two = fixture.OwnedDaemon(config_root)
            daemon_two.start()
            recovered = fixture.projection(daemon_two, session_id)
            fixture.require((recovered.get("run") or {}).get("status") == "completed", "重启后完成态丢失")
            fixture.require(int(recovered["revision"]) == final_revision, "重启后 projection revision 漂移")
            assert_projection_flow(recovered)
            second_input = [message for message in recovered["messages"] if message["role"] == "user"][1]
            fixture.require(second_input["filesystemReferences"] == [reference], "长文本原文引用在接纳或重启后漂移")
            fixture.require(second_input["content"] != LONG_INPUT, "长文本未从命令传输中资源化")
            segments: list[str] = []
            cursor: int | None = None
            while True:
                query = {"workspaceId": reference["workspaceId"], "logicalPath": reference["logicalPath"]}
                if cursor is not None:
                    query["startByte"] = cursor
                page = fixture.api_json(daemon_two.base_url,
                    f"/api/conversation/sessions/{urllib.parse.quote(session_id, safe='')}/resources/read",
                    token=daemon_two.token, method="POST", body=query)
                fixture.require(len(page["content"].encode("utf-8")) <= 262144, "资源读取超过单次字节预算")
                segments.append(page["content"])
                next_byte = page.get("nextByte")
                if next_byte is None:
                    break
                fixture.require(next_byte > (cursor or 0), "资源续读游标没有前进")
                cursor = next_byte
            fixture.require(len(segments) > 1 and "".join(segments) == LONG_INPUT, "分页读取未完整保留 Unicode 原文")
            assert_provider_count_stable(provider, 4)
            fixture.require(len(provider.title_requests) == 1, "标题请求未独立处理或在重启后重复生成")
            assert_shells_read_projection(daemon_two, session_id, final_revision)
            path_id = urllib.parse.quote(session_id, safe="")
            original_references = recovered["messages"][0]["filesystemReferences"]
            fixture.require(original_references == filesystem_references, "重启后原文件引用身份漂移")
            original_reference = original_references[0]
            resource_endpoint = f"/api/conversation/sessions/{path_id}/resources/read"
            original_query = {"workspaceId": original_reference["workspaceId"],
                              "logicalPath": original_reference["logicalPath"]}
            located = fixture.api_json(daemon_two.base_url, resource_endpoint, token=daemon_two.token,
                                       method="POST", body={**original_query, "format": "path"})
            fixture.require(located.get("kind") == "file" and Path(located["path"]).samefile(attachment_file),
                            "Session 文件引用没有定位到外部原文件")
            original_read = fixture.api_json(daemon_two.base_url, resource_endpoint, token=daemon_two.token,
                                            method="POST", body=original_query)
            fixture.require(original_read["content"] == ATTACHMENT_CONTENT, "重启后无法通过原引用读取附件原文")
            catalog_database = config_root / "data" / "agent-runtime" / "catalog.sqlite3"
            with closing(fixture.sqlite_read_only(catalog_database)) as connection:
                owned_roots = [Path(row[0]) for row in connection.execute(
                    "SELECT canonical_root FROM workspaces WHERE owner_session_id=?", (session_id,))]
            fixture.require(owned_roots and all(root.is_dir() for root in owned_roots),
                            "删除前没有完整保留 Session 托管的文本资源和工作目录")
            fixture.require(all(root.resolve() not in attachment_file.resolve().parents for root in owned_roots),
                            "外部原文件被错误归入 Session 托管目录")
            fixture.api_json(
                daemon_two.base_url,
                f"/api/conversation/sessions/{path_id}",
                token=daemon_two.token,
                method="DELETE",
                timeout=12,
            )
            revoked = fixture.api_envelope(daemon_two.base_url, resource_endpoint, token=daemon_two.token,
                                          method="POST", body=original_query)
            fixture.require(revoked.get("ok") is False and revoked.get("error") == "session_not_found",
                            f"Session 删除后原引用仍可读取或错误事实不正确：{revoked}")
            fixture.require(all(not root.exists() for root in owned_roots), "Session 删除后仍保留托管资源目录")
            fixture.require(attachment_file.read_text(encoding="utf-8") == ATTACHMENT_CONTENT,
                            "Session 删除修改或移除了外部原文件")
            daemon_two.shutdown()

            print(
                "[local-agent-e2e] PASS "
                "basic-loop/sequential-tools/web/first-party-plugin/pdf-binding/cache/release/restart/"
                "filesystem-reference/long-input/bounded-read/shared-projection "
                "(CLI chain verification only; not GUI, package, or release acceptance)"
            )
        finally:
            provider.release_first_request.set()
            with ExitStack() as cleanup:
                cleanup.callback(provider_thread.join, timeout=3)
                cleanup.callback(provider_server.server_close)
                cleanup.callback(provider_server.shutdown)
                if daemon_one is not None:
                    cleanup.callback(daemon_one.close)
                if daemon_two is not None:
                    cleanup.callback(daemon_two.close)
                if cli_ask is not None:
                    cli_ask.terminate()
                    try:
                        cli_ask.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        cli_ask.kill()
                        cli_ask.wait(timeout=3)


if __name__ == "__main__":
    main()
