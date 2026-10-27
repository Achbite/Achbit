#!/usr/bin/env python3
"""Real CLI/Session/Kernel regression with deterministic Provider inputs; no GUI/TUI."""

from __future__ import annotations

from contextlib import closing
import base64
import http.server
import importlib.util
import json
import tempfile
import threading
from pathlib import Path


spec = importlib.util.spec_from_file_location("achbit_test_support", Path(__file__).with_name("support.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
require = fixture.require
LONG_INPUT = "  原始任务与资料🙂\n" + "保持原文空白与每一项约束。  \n" * 2200
SCRIPT = 'value=\'hello world\'\nprintf \'%s\\n\' "$value"\ncat <<\'END\'\nliteral $value\nEND\ntest -d "$TMPDIR" && test "$TMP" = "$TMPDIR" && test "$TEMP" = "$TMPDIR" || exit 91\nprintf \'temp-write-ok\\n\' > "$TMPDIR/probe.txt" || exit $?\ntest "$(cat "$TMPDIR/probe.txt")" = temp-write-ok || exit 92\nprintf \'kernel-temp:%s\\n\' "$TMPDIR"\n'
PHASES = [{"stepId": f"phase-{index}", "title": f"验证阶段 {index}", "details": "检查文本修改与执行结果。",
           "verification": [f"核对结果 {check}" for check in range(9)]} for index in range(13)]
WRITE_PATHS = [{"path": "build", "kind": "directory"}] + [
    {"path": f"build/output-{index}", "kind": "directory"} for index in range(128)
]
INTRO = {"type": "message", "id": "msg_cli_intro", "role": "assistant", "phase": "commentary",
         "status": "completed", "content": [{"type": "output_text", "text": "I will inspect the current file."}]}


class ProviderHandler(fixture.MockProviderHandler):
    def do_POST(self) -> None:  # noqa: N802
        if getattr(self.provider_state, "attachment_mode", False):
            self.respond_attachments()
            return
        if self.path.endswith("/responses"):
            self.respond_native()
            return
        headers_sent = False
        try:
            require(self.path.endswith("/chat/completions"), "Provider endpoint 不匹配")
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            if self.respond_to_title(body):
                return
            ordinal, names, results = self.provider_state.inspect(body)
            self.send_response(200)
            self.send_header("content-type", "text/event-stream; charset=utf-8")
            self.send_header("connection", "close")
            self.end_headers()
            headers_sent = True
            if ordinal == 1:
                self._send_tool_calls([
                    ("read-default", names["read"], {"path": "probe.txt"}),
                    ("unknown-tool", "undeclared_tool", {"path": "probe.txt"}),
                    ("missing-file", names["read"], {"path": "does-not-exist.txt"}),
                    ("bad-timeout", names["bash"], {"command": "pwd", "timeout": 0}),
                    ("bad-field", names["edit"], {"path": "probe.txt", "workspaceMode": "write", "edits": [{"oldText": "alpha", "newText": "ALPHA"}]}),
                    ("bad-workspace", names["read"], {"path": "probe.txt", "workspace": "workspace99"}),
                    ("shell-format", names["bash"], {"command": SCRIPT, "requestHostPermission": "Verify the explicitly approved Host Shell and temporary files."}),
                    ("blocked-command", names["bash"], {"command": "printf denylist-probe"}),
                ])
            elif ordinal == 2:
                require(results["read-default"]["outcome"] == "completed", "默认 workspace 文件读取失败")
                rejected = results["unknown-tool"]
                require(rejected["status"] == "inputRejected" and rejected["executed"] is False
                        and rejected["error"]["code"] == "provider_tool_alias_unknown", "未知工具未明确拒绝")
                missing = results["missing-file"]
                require(missing["outcome"] == "failed" and missing["error"]["code"] == "fs_read_metadata_failed"
                        and "does-not-exist.txt" in missing["error"]["message"], "文件不存在的原始错误丢失")
                for call_id, path, rule in [("bad-timeout", "$.timeout", "minimum"), ("bad-field", "$.workspaceMode", "additionalProperties")]:
                    rejected = results[call_id]
                    require(rejected["status"] == "inputRejected" and rejected["executed"] is False, "非法输入被执行")
                    require(any(issue["path"] == path and issue["rule"] == rule for issue in rejected["error"]["issues"]), "字段诊断没有到达 Provider")
                require("primary" in results["bad-workspace"]["error"]["message"], "句柄拒绝未列出合法值")
                require(results["shell-format"]["outcome"] == "completed", "合法多行命令未执行")
                blocked = results["blocked-command"]
                require(blocked["outcome"] == "denied" and blocked["error"]["code"] == "command_denied_by_rule"
                        and 'printf denylist-probe' in blocked["error"]["message"], "全部允许模式未在执行前阻止自定义黑名单命令")
                shell_output = results["shell-format"]["output"]
                require(shell_output["executionScope"] == "host", "Kernel 未在用户批准后选择真实 Host 执行")
                require(shell_output["stdout"].startswith("hello world\nliteral $value\n"), "多行脚本原始输出不符")
                temporary_lines = [line for line in shell_output["stdout"].splitlines() if line.startswith("kernel-temp:")]
                require(len(temporary_lines) == 1, "Shell 未返回本次 Kernel 临时目录")
                temporary = Path(temporary_lines[0].removeprefix("kernel-temp:"))
                require(temporary.is_absolute() and not temporary.exists(), "Shell 结束后 Kernel 临时目录未删除")
                self._send_tool_calls([("plan", names["plan"], {
                    "title": "修复 probe.txt", "summary": "按读取到的文本修改并验证。",
                    "steps": PHASES,
                    "mutationManifest": [
                        {"workspace": "primary", "operation": "fs.edit", "target": "probe.txt"},
                        {"workspace": "primary", "operation": "bash", "command": "make build", "writablePaths": WRITE_PATHS},
                        {"workspace": "primary", "operation": "fs.edit", "target": "src", "targetKind": "directoryTree"},
                    ] + [{"workspace": "primary", "operation": "fs.write", "target": f"reserved/target-{index}.txt"} for index in range(126)],
                })])
            elif ordinal == 3:
                self._send_tool_calls([("edit-mismatch", names["edit"], {"path": "probe.txt", "edits": [
                    {"oldText": "alpha", "newText": "ALPHA"},
                    {"oldText": "missing", "newText": "replacement"},
                ]}),
                    ("directory-create", names["write"], {"path": "src/nested/new.txt", "content": "created within approved directory\n"}),
                    ("outside-scope", names["write"], {"path": "extra/new.txt", "content": "expanded scope\n"}),
                ])
            elif ordinal == 4:
                require(results["directory-create"]["outcome"] == "completed", "目录授权未覆盖后代新文件")
                require((self.provider_state.workspace / "src/nested/new.txt").read_text() == "created within approved directory\n", "目录内文件内容不符")
                denied = results["outside-scope"]
                require(denied["outcome"] == "denied" and denied["error"]["code"] == "plan_scope_required", "范围外写入未返回 Plan 范围拒绝")
                require(bool(denied["error"]["message"]), "范围拒绝的原始说明丢失")
                require(not (self.provider_state.workspace / "extra/new.txt").exists(), "未确认的范围已执行")
                failed = results["edit-mismatch"]
                require(failed["outcome"] == "failed" and failed["error"]["code"] == "patch_match_not_found", "编辑原始错误码丢失")
                require(failed["output"]["details"]["editIndex"] == 1, "编辑诊断没有失败索引")
                require((self.provider_state.workspace / "probe.txt").read_text() == "alpha\nbeta\n", "失败批次部分修改了文件")
                self._send_tool_calls([("edit-corrected", names["edit"], {"path": "probe.txt", "edits": [{"oldText": "alpha", "newText": "ALPHA"}]})])
            elif ordinal == 5:
                require(results["edit-corrected"]["outcome"] == "completed", "纠正后编辑失败")
                require((self.provider_state.workspace / "probe.txt").read_text() == "ALPHA\nbeta\n", "修改内容不正确")
                preview = results["edit-corrected"]["output"]["editPreview"]
                require(preview["hunks"][0]["before"] == "alpha\n" and preview["hunks"][0]["after"] == "ALPHA\n" and not preview["truncated"], "实际编辑摘要未到达模型")
                self._send_tool_calls([("progress", names["progress"], {
                    "items": [{"text": phase["title"], "status": "completed" if index == 0 else "inProgress"} for index, phase in enumerate(PHASES)],
                })])
            elif ordinal == 6:
                self._send_tool_calls([("extend-scope", names["plan"], {
                    "mode": "extendScope", "summary": "新增 extra 目录写入范围，阶段及验收不变。",
                    "mutationManifest": [{"workspace": "primary", "operation": "fs.write", "target": "extra", "targetKind": "directoryTree"}],
                })])
            elif ordinal == 7:
                require(results["progress"] == {"accepted": True}, "模型提交的进度缺少已接受回执")
                self._send_tool_calls([
                    ("expanded-create", names["write"], {"path": "extra/new.txt", "content": "expanded scope\n"}),
                    ("pipeline-status", names["bash"], {"requestHostPermission": "Verify the original Host pipeline exit status.", "command": "set -o pipefail\n(printf 'expected failure\\n'; exit 7) | tail -1"}),
                    ("expected-nonzero", names["bash"], {"requestHostPermission": "Verify a separate Host approval for expected nonzero handling.", "command": "if (exit 7); then rc=0; else rc=$?; fi\ntest \"$rc\" -eq 7"}),
                ])
            elif ordinal == 8:
                require(results["expanded-create"]["outcome"] == "completed", "确认范围补充后未执行")
                require((self.provider_state.workspace / "extra/new.txt").read_text() == "expanded scope\n", "补范围后内容不符")
                require(results["pipeline-status"]["outcome"] == "failed" and results["pipeline-status"]["output"]["exitCode"] == 7,
                        "管道原始失败退出码丢失: " + json.dumps(results["pipeline-status"], ensure_ascii=False))
                require(results["expected-nonzero"]["outcome"] == "completed",
                        "预期非零处理失败: " + json.dumps(results["expected-nonzero"], ensure_ascii=False))
                self._send_tool_calls([("progress-final", names["progress"], {
                    "items": [{"text": phase["title"], "status": "completed"} for phase in PHASES],
                })])
            elif ordinal == 9:
                require(results["progress-final"] == {"accepted": True}, "最终进度没有被接受")
                self._send_text("tool-input-cli-complete")
            elif ordinal == 10:
                message = next(message for message in reversed(body["messages"]) if message["role"] == "user")
                content = message["content"]
                require(LONG_INPUT not in content, "原文被重复塞入 Provider 文本")
                require("nextByte" in content, "模型未收到原文读取指导")
                references = json.loads(content[content.index("[{\"referenceId\""):])
                reference = next(item for item in references if item.get("source") == "pastedText")
                self._send_tool_calls([("read-pasted", names["read"], {"workspace": reference["workspace"], "path": reference["path"], "maxLines": 5000})])
            elif ordinal == 11:
                require(results["read-pasted"]["output"]["content"] == LONG_INPUT, "读取到的粘贴文本不完整")
                self._send_text("pasted-text-cli-complete")
            else:
                raise AssertionError(f"多余 Provider 请求：{ordinal}")
        except BaseException as error:
            self.provider_state.record_failure(error)
            if not headers_sent:
                self.send_error(500)
            self.close_connection = True

    def respond_attachments(self) -> None:
        try:
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            if self.respond_to_title(body):
                return
            state = self.provider_state
            state.attachment_requests.append(body)
            ordinal = len(state.attachment_requests)
            tools = {tool["function"]["name"]: tool["function"] for tool in body["tools"]}
            read_name = next(name for name, tool in tools.items() if "startByte" in tool["parameters"].get("properties", {}))
            self.send_response(200)
            self.send_header("content-type", "text/event-stream; charset=utf-8")
            self.send_header("connection", "close")
            self.end_headers()
            if ordinal == 1:
                state.attachment_started.set()
                require(state.attachment_release.wait(30), "附件请求未获准继续")
                self._send_tool_calls([("before-attachment", read_name, {"path": "probe.txt"})])
            elif ordinal == 2:
                require(body["messages"][:len(state.attachment_requests[0]["messages"])] == state.attachment_requests[0]["messages"], "追加附件改写了旧请求前缀")
                parts = [part for message in body["messages"] if isinstance(message.get("content"), list) for part in message["content"]]
                require(any(part.get("type") == "image_url" and part["image_url"]["url"] == state.attachment_image_url for part in parts), "PNG 没有按真实字节编码进入 Provider")
                content = next(message["content"] for message in reversed(body["messages"]) if message["role"] == "user" and isinstance(message["content"], str) and "notes.txt" in message["content"])
                references = json.loads(content[content.index('[{"referenceId"'):])
                reference = next(item for item in references if item["path"] == "notes.txt")
                self._send_tool_calls([("queued-file-read", read_name, {"workspace": reference["workspace"], "path": reference["path"]})])
            elif ordinal == 3:
                result = next(json.loads(message["content"]) for message in body["messages"] if message.get("tool_call_id") == "queued-file-read")
                require(result["outcome"] == "completed" and result["output"]["content"] == "queued notes\n", "Kernel 未读取本轮新接纳的原文件")
                self._send_text("queued-attachments-complete")
            else:
                raise AssertionError(f"多余附件请求：{ordinal}")
        except BaseException as error:
            self.provider_state.record_failure(error)
            self.close_connection = True

    def respond_native(self) -> None:
        headers_sent = False
        try:
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            if self.respond_to_title(body):
                return
            requests = self.provider_state.responses_requests
            requests.append(body)
            ordinal = len(requests)
            require(body["tools"] == requests[0]["tools"], "Responses 工具目录发生变化")
            require(body["input"][:len(requests[0]["input"])] == requests[0]["input"], "Responses 稳定前缀被重写")
            if ordinal == 1:
                item = INTRO
            elif ordinal == 2:
                require(INTRO in body["input"], "独立 commentary 没有按原生项重放")
                item = {"type": "function_call", "id": "fc_unknown", "call_id": "call_unknown", "name": "undeclared_tool",
                        "arguments": "{}", "status": "completed"}
            elif ordinal == 3:
                output = next(item for item in body["input"] if item.get("type") == "function_call_output" and item.get("call_id") == "call_unknown")
                result = json.loads(output["output"])
                require(result["status"] == "inputRejected" and result["executed"] is False
                        and result["error"]["code"] == "provider_tool_alias_unknown", "Responses 未回传未知工具拒绝")
                read_tool = next(tool for tool in body["tools"] if "startByte" in tool.get("parameters", {}).get("properties", {}))
                item = {"type": "function_call", "id": "fc_cli_read", "call_id": "call_cli_read", "name": read_tool["name"],
                        "arguments": json.dumps({"path": "probe.txt"}), "status": "completed"}
            elif ordinal == 4:
                output = next(item for item in body["input"] if item.get("type") == "function_call_output" and item.get("call_id") == "call_cli_read")
                result = json.loads(output["output"])
                require(result["outcome"] == "completed" and result["output"]["content"] == "ALPHA\nbeta\n", "续跑中的真实工具结果缺失")
                item = {**INTRO, "id": "msg_cli_final", "phase": "final_answer",
                        "content": [{"type": "output_text", "text": "commentary-cli-complete"}]}
            else:
                raise AssertionError(f"多余 Responses 请求：{ordinal}")
            self.send_response(200)
            self.send_header("content-type", "text/event-stream; charset=utf-8")
            self.send_header("connection", "close")
            self.end_headers()
            headers_sent = True
            events = []
            if item["type"] == "message":
                events.append({"type": "response.output_text.delta", "output_index": 0, "delta": item["content"][0]["text"]})
            events.extend([
                {"type": "response.output_item.done", "output_index": 0, "item": item},
                {"type": "response.completed", "response": {}},
            ])
            for event in events:
                self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                self.wfile.flush()
        except BaseException as error:
            self.provider_state.record_failure(error)
            if not headers_sent:
                self.send_error(500)
            self.close_connection = True



def require_unexecuted_approval(daemon, projection):
    approval = projection["pendingApproval"]
    require(approval is not None and projection["run"]["status"] == "waiting"
            and projection["run"]["waitingReason"] == "approval", "调用未停在审批门禁")
    runtime = daemon.config_root / "data" / "agent-runtime"
    with closing(fixture.sqlite_read_only(runtime / "session.sqlite3")) as connection:
        started = connection.execute("SELECT COUNT(*) FROM session_events WHERE session_id=? AND call_id=? AND event_type='tool.started'",
                                     (projection["sessionId"], approval["callId"])).fetchone()[0]
        require(started == 0, "用户批准前调用已进入执行边界")
    with closing(fixture.sqlite_read_only(runtime / "tool-record.sqlite3")) as connection:
        records = connection.execute("SELECT COUNT(*) FROM tool_records WHERE call_id=?", (approval["callId"],)).fetchone()[0]
        require(records == 0, "待批准调用不应已有执行终态")
    return approval


def verify_queued_attachments(daemon, state, root, workspace) -> None:
    state.attachment_mode = True
    state.attachment_requests = []
    state.attachment_started = threading.Event()
    state.attachment_release = threading.Event()
    png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=")
    (root / "screen.png").write_bytes(png)
    (root / "notes.txt").write_text("queued notes\n")
    state.attachment_image_url = "data:image/png;base64," + base64.b64encode(png).decode()
    session_id = fixture.create_session(daemon, workspace)["sessionId"]
    endpoint = f"/api/conversation/sessions/{session_id}"
    def submit(command_id, text, **extra):
        return fixture.api_json(daemon.base_url, endpoint + "/commands", token=daemon.token, method="POST", body={
            "schemaVersion": "achbit.command.v3", "type": "message.submit", "commandId": command_id,
            "sessionId": session_id, "text": text, **extra,
        })
    try:
        require(submit("command:attachment-start", "Read the file, then consider my attachments.", profileId="e2e-main")["status"] == "accepted", "附件任务未接纳")
        require(state.attachment_started.wait(20), "初始 Provider 请求未开始")
        run_id = fixture.projection(daemon, session_id)["run"]["runId"]
        for filename in ["screen.png", "notes.txt"]:
            references = fixture.api_json(daemon.base_url, endpoint + "/filesystem-references/resolve", token=daemon.token, method="POST", body={
                "references": [{"path": str(root / filename), "kind": "file"}],
            })
            reply = submit(f"command:attach-{filename}", "", runId=run_id, filesystemReferences=references)
            require(reply["status"] == "accepted", "运行中仅附件消息被拒绝: " + json.dumps(reply, ensure_ascii=False))
        queued = fixture.projection(daemon, session_id)
        require(len(queued["queuedInputs"]) == 2, "附件未留在同一任务队列")
        state.attachment_release.set()
        fixture.wait_until(lambda: fixture.projection(daemon, session_id).get("pendingApproval"), 20, "外部原文件读取未请求批准")
        pending = fixture.projection(daemon, session_id)["pendingApproval"]
        require(pending["preview"]["fileAccess"]["read"] == [str((root / "notes.txt").resolve())], "外部读取批准目标不符")
        fixture.cli(daemon, session_id, "/reply 1")
        completed = fixture.wait_completed(daemon, state, session_id, "queued-attachments-complete")
        require(completed["run"]["runId"] == run_id and not completed["queuedInputs"], "附件另起任务或未消费")
        require(len(state.attachment_requests) == 3, "附件链路请求次数不符")
        print("[attachment-e2e] PASS: same-run image-only and file-only input, real PNG Provider encoding, immutable old prefix and approved original-file read")
    finally:
        state.attachment_release.set()


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="achbit-tool-input-cli-") as directory:
        root = Path(directory)
        workspace = root / "workspace"
        workspace.mkdir()
        (workspace / "probe.txt").write_text("alpha\nbeta\n")
        state = fixture.ProviderState(workspace)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), ProviderHandler)
        server.provider_state = state
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        daemon = fixture.OwnedDaemon(root / "config")
        try:
            fixture.write_configuration(daemon.config_root, f"http://127.0.0.1:{server.server_port}/v1", {
                "agent.permissions.workspaceMutation": "plan", "agent.permissions.external": "allow",
                "agent.permissions.commandDenylist": ["rm -rf /", "printf denylist-probe"],
            })
            profiles_path = daemon.config_root / "config/user/local/settings/llm-profiles.json"
            profiles = json.loads(profiles_path.read_text())
            profiles["profiles"][0]["maxOutputTokens"] = 16384
            profiles["profiles"][0]["imageInput"] = True
            profiles["profiles"].append({**profiles["profiles"][0], "id": "e2e-responses", "kind": "responses"})
            profiles_path.write_text(json.dumps(profiles))
            daemon.start()
            session = fixture.create_session(daemon, workspace)
            session_id = session["sessionId"]
            fixture.cli(daemon, session_id, "读取 probe.txt，检查工具反馈并按 Plan 修复。", expected=5)
            state.assert_healthy()
            shell_waiting = fixture.projection(daemon, session_id)
            shell_approval = require_unexecuted_approval(daemon, shell_waiting)
            require(SCRIPT in shell_approval["preview"]["summary"] and shell_waiting["pendingPlan"] is None,
                    "未声明 Shell 应先请求该调用审批")
            require(len(state.requests) == 1, "Shell 待批准期间 Provider 已提前续跑")
            fixture.cli(daemon, session_id, "/reply 1", expected=5)
            state.assert_healthy()
            waiting = fixture.projection(daemon, session_id)
            require(waiting["pendingPlan"]["mutationManifest"][1]["writablePaths"] == WRITE_PATHS, "Plan 写入范围未完整保留")
            require(len(waiting["pendingPlan"]["steps"]) == 13 and len(waiting["pendingPlan"]["mutationManifest"]) == 129, "计划被旧数量限制截断")
            first_plan = waiting["pendingPlan"]
            fixture.cli(daemon, session_id, "/reply 确认", expected=5)
            state.assert_healthy()
            extension = fixture.projection(daemon, session_id)
            require(extension["pendingApproval"] is None and extension["run"]["waitingReason"] == "plan",
                    "范围外写入应由 Agent 调整 Plan，不应变为命令审批")
            require(extension["pendingPlan"]["planId"] == first_plan["planId"] and extension["pendingPlan"]["revision"] == 2, "范围补充没有沿用当前 Plan")
            require(extension["pendingPlan"]["steps"] == first_plan["steps"], "只补范围重写了阶段或验收")
            require(extension["pendingPlan"]["summary"].startswith(first_plan["summary"] + "\n\n"), "只补范围丢失原目标摘要")
            require(len(extension["pendingPlan"]["mutationManifest"]) == 130, "范围补充未保留完整原清单")
            expected_statuses = ["completed"] + ["inProgress"] * 12
            require([item["status"] for item in extension["todoList"]["items"]] == expected_statuses, "待确认修订重置进度")
            require([item["text"] for item in extension["todoList"]["items"]] == [phase["title"] for phase in PHASES], "进度投影没有保留模型提交的内容")
            require(not (workspace / "extra/new.txt").exists(), "范围补充确认前发生写入")
            fixture.cli(daemon, session_id, "/reply 确认", expected=5)
            state.assert_healthy()
            pipeline_waiting = fixture.projection(daemon, session_id)
            pipeline_approval = require_unexecuted_approval(daemon, pipeline_waiting)
            require("set -o pipefail" in pipeline_approval["preview"]["summary"]
                    and "external" in pipeline_approval["preview"]["effects"],
                    "已确认 Plan 不能代替本次 Host 管道命令审批")
            require(pipeline_waiting["plans"][-1]["mutationManifest"] == extension["pendingPlan"]["mutationManifest"],
                    "Host 调用审批改变了 Plan 范围")
            fixture.cli(daemon, session_id, "/reply 1", expected=5)
            state.assert_healthy()
            expected_waiting = fixture.projection(daemon, session_id)
            expected_approval = require_unexecuted_approval(daemon, expected_waiting)
            require('test "$rc" -eq 7' in expected_approval["preview"]["summary"]
                    and "external" in expected_approval["preview"]["effects"],
                    "前一调用审批不能覆盖下一次 Host 调用")
            require(pipeline_approval["callId"] != expected_approval["callId"], "两条 Host 命令复用了调用身份")
            require("tool-input-cli-complete" in fixture.cli(daemon, session_id, "/reply 1").stdout, "CLI 未输出完成正文")
            state.assert_healthy()
            after_extension = fixture.projection(daemon, session_id)
            require(after_extension["plans"][-1]["steps"] == first_plan["steps"], "确认后阶段及验收被重写")
            require([item["text"] for item in after_extension["todoList"]["items"]] == [item["text"] for item in extension["todoList"]["items"]], "确认后 Todo 内容改变")
            require("pasted-text-cli-complete" in fixture.cli(daemon, session_id, LONG_INPUT).stdout, "CLI 未完成粘贴原文读取")
            state.assert_healthy()
            completed = fixture.projection(daemon, session_id)
            require(completed["run"]["status"] == "completed", "最终 Session 未完成")
            user = next(message for message in reversed(completed["messages"]) if message["role"] == "user")
            require(user["content"] == "", "长文本转换泄漏了内部指导到用户气泡")
            require(user["filesystemReferences"][0]["source"] == "pastedText", "长文本来源丢失")
            require(len(completed["todoList"]["items"]) == 13 and all(item["status"] == "completed" for item in completed["todoList"]["items"]), "阶段进度没有完整更新")
            native_session_id = fixture.create_session(daemon, workspace)["sessionId"]
            reply = fixture.api_json(daemon.base_url, f"/api/conversation/sessions/{native_session_id}/commands", token=daemon.token, method="POST", body={
                "schemaVersion": "achbit.command.v3", "type": "session.model-settings.set", "commandId": "command:responses-profile",
                "sessionId": native_session_id, "settings": {"profileId": "e2e-responses", "reasoningEffortOverride": None},
            })
            require(reply["status"] == "accepted", "Responses profile 未接受")
            native_output = fixture.cli(daemon, native_session_id, "检查当前文件并说明结果。")
            require("commentary-cli-complete" in native_output.stdout, "CLI 在过程说明后提前结束")
            state.assert_healthy()
            native_projection = fixture.projection(daemon, native_session_id)
            require(native_projection["run"]["status"] == "completed", "commentary 续跑未完成")
            verify_queued_attachments(daemon, state, root, workspace)
            daemon.shutdown()
            runtime = daemon.config_root / "data" / "agent-runtime"
            with closing(fixture.sqlite_read_only(runtime / "session.sqlite3")) as connection:
                rows = connection.execute("SELECT event_type, call_id, payload_json FROM session_events WHERE session_id IN (?,?) ORDER BY session_id, sequence", (session_id, native_session_id)).fetchall()
                requested = {call_id for kind, call_id, _ in rows if kind == "tool.requested"}
                terminal = {call_id for kind, call_id, _ in rows if kind in {"tool.completed", "tool.input-rejected", "tool.interrupted"}}
                require(requested == terminal, "工具调用缺少持久化终态")
                require(sum(kind == "run.runtime.released" for kind, _, _ in rows) == 3, "三个 run 未全部释放 runtime")
                approvals = [json.loads(payload) for kind, _, payload in rows if kind == "approval.resolved"]
                require([item["decision"] for item in approvals] == ["allow", "allow", "allow"],
                        "应逐次批准三条 Host 命令，Plan 范围拒绝不应生成工具审批")
                native_run = native_projection["run"]["runId"]
                native_events = [json.loads(row[0]) for row in connection.execute(
                    "SELECT payload_json FROM session_events WHERE session_id=? AND run_id=? AND event_type='provider.turn.settled' ORDER BY sequence", (native_session_id, native_run))]
                require(len(native_events) == 4, "独立说明、调用拒绝、工具调用和最终回答没有保持同一 run")
                require(native_events[0]["orderedCallIds"] == [] and native_events[0]["orderedOutputBlocks"][0]["kind"] == "narrative", "commentary 被持久化为最终答复")
                require(native_events[1]["orderedCallIds"] == [] and native_events[1]["orderedOutputBlocks"][0]["kind"] == "toolCallRejected", "未知工具被登记为可执行调用")
            with closing(fixture.sqlite_read_only(runtime / "tool-record.sqlite3")) as connection:
                records = [json.loads(row[0]) for row in connection.execute("SELECT record_json FROM tool_records WHERE session_id=?", (session_id,))]
                shell = next(record for record in records if record["toolName"] == "bash" and record["input"]["command"] == SCRIPT)
                require(shell["input"]["command"] == SCRIPT, "Bash 脚本被改写")
                blocked = next(record for record in records if record["input"].get("command") == "printf denylist-probe")
                require(blocked["outcome"] == "denied" and blocked["error"]["code"] == "command_denied_by_rule"
                        and blocked["authority"]["matchedRule"] == "printf denylist-probe" and "output" not in blocked,
                        "自定义黑名单拒绝事实未完整落库")
                require(not any(kind == "tool.started" and call_id == blocked["callId"] for kind, call_id, _ in rows),
                        "黑名单命令不应进入执行边界")
                require(any(record.get("error", {}).get("code") == "patch_match_not_found" for record in records), "原始编辑失败未落库")
                outside = next(record for record in records if record.get("error", {}).get("code") == "plan_scope_required")
                require(not any(kind == "tool.started" and call_id == outside["callId"] for kind, call_id, _ in rows),
                        "范围外编辑不应进入执行边界")
            require(len(state.requests) == 11, "Provider 调用次数不符")
            require(len(state.responses_requests) == 4, "Responses 续跑调用次数不符")
            print("[cli-e2e] PASS: unknown tools rejected in aggregate/Responses, missing-file errors preserved, explicit call approval before Host execution, configured command rule denied before spawn, Kernel TMPDIR write and cleanup, directory scope, Kernel Plan-scope denial before execution, confirmed scope extension preserving phases, edit preview and shell exit status; 13 phases/129 initial targets, pasted text, native commentary/rejection/tool/final continuation, paired history and 3 runtime releases (fixture Provider; no GUI)")
        except BaseException:
            state.assert_healthy()
            print(daemon.log_tail())
            raise
        finally:
            daemon.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)
            require(not thread.is_alive(), "Provider fixture 未退出")


if __name__ == "__main__":
    main()
