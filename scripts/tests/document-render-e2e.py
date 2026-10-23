#!/usr/bin/env python3
"""Actual CLI/Session/Kernel document flow with a deterministic local Provider."""
import argparse
import http.server
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import threading
import urllib.parse
import urllib.request

spec = importlib.util.spec_from_file_location("deepcode_test_support", Path(__file__).with_name("support.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
require = fixture.require
HTML = (fixture.ROOT / "skills/achbit-documents/assets/document.html").read_text().replace("文档标题", "文档预览 · Document report").replace(
    "与读者和用途相关的简短说明", "同一份内容 · HTML / PDF / Markdown").replace("章节标题", "清晰的排版").replace(
    "替换为用户要求的正文。根据实际内容增删章节，不保留示例文字。",
    "Document rendering verification. 中文正文、标题层级和留白。<strong>重点信息</strong>保持清晰。").replace(
    "</main>", '<section style="break-before:page"><h2>第二页 · Second page</h2><p>Selectable PDF text.</p></section></main>')
MARKDOWN = "# 文档报告\n\n清晰的 **Markdown** 正文。\n\n| 格式 | 用途 |\n| --- | --- |\n| PDF | 分享 |\n| HTML | 浏览 |\n"


class State:
    def __init__(self):
        self.calls = 0
        self.failure = None
        self.title_requests = []

    def record_failure(self, error):
        self.failure = error

    def assert_healthy(self):
        if self.failure:
            raise AssertionError(str(self.failure)) from self.failure


class Handler(fixture.MockProviderHandler):
    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            if self.respond_to_title(body):
                return
            state = self.provider_state
            state.calls += 1
            functions = [entry["function"] for entry in body["tools"]]
            skill = next(entry["name"] for entry in functions if "achbit-documents" in entry["parameters"].get("properties", {}).get("name", {}).get("enum", []))
            renderer = next(entry["name"] for entry in functions if "pdf" in entry["parameters"].get("properties", {}).get("format", {}).get("enum", []))
            reader = next(entry["name"] for entry in functions if "startByte" in entry["parameters"].get("properties", {}))
            results = {message["tool_call_id"]: json.loads(message["content"]) for message in body["messages"] if message["role"] == "tool"}
            if state.calls == 2:
                require(results["skill"]["outcome"] == "completed", "Built-in document Skill failed")
                require("document.render" in results["skill"]["output"]["content"], "Skill content missing")
            elif state.calls == 3:
                for name in ["html", "pdf", "markdown"]:
                    require(results[name]["outcome"] == "completed", f"Document export failed: {results[name]}")
                require(results["missing"]["outcome"] == "failed", "Read failure was not preserved")
            self.send_response(200)
            self.send_header("content-type", "text/event-stream; charset=utf-8")
            self.send_header("connection", "close")
            self.end_headers()
            if state.calls == 1:
                self._send_tool_calls([("skill", skill, {"name": "achbit-documents"})])
            elif state.calls == 2:
                self._send_tool_calls([
                    ("html", renderer, {"path": "报告.html", "format": "html", "content": HTML}),
                    ("pdf", renderer, {"path": "报告.pdf", "format": "pdf", "content": HTML}),
                    ("markdown", renderer, {"path": "报告.md", "format": "markdown", "content": MARKDOWN}),
                    ("missing", reader, {"path": "missing.txt"}),
                ])
            else:
                self._send_text("文档已生成，缺失文件的读取错误已保留。\n\n在产物中打开 `报告.html`、`报告.pdf` 或 `报告.md` 预览。")
        except BaseException as error:
            self.provider_state.record_failure(error)
            self.close_connection = True


def verify_resources(daemon, projection, workspace):
    require(projection["run"]["status"] == "completed", "Document run did not complete")
    artifacts = projection["artifacts"]
    require({item["logicalPath"] for item in artifacts} == {"报告.html", "报告.pdf", "报告.md"}, "Artifacts differ from generated files")
    types = {"html": "text/html", "pdf": "application/pdf", "md": "text/markdown"}
    session = urllib.parse.quote(projection["sessionId"], safe="")
    for artifact in artifacts:
        path = artifact["logicalPath"]
        request = urllib.request.Request(f"{daemon.base_url}/api/conversation/sessions/{session}/resources/read",
            data=json.dumps({"workspaceId": artifact["workspaceId"], "logicalPath": path, "format": "document"}).encode(),
            headers={"content-type": "application/json", fixture.HOST_TOKEN_HEADER: daemon.token})
        with fixture.URL_OPENER.open(request, timeout=10) as response:
            require(response.headers.get_content_type() == types[path.rsplit(".", 1)[1]], "Wrong document content type")
            require(response.read() == (workspace / path).read_bytes(), "Preview bytes differ from the written artifact")
    require((workspace / "报告.html").read_text() == HTML, "HTML source changed")
    require((workspace / "报告.md").read_text() == MARKDOWN, "Markdown source changed")
    require((workspace / "报告.pdf").read_bytes().startswith(b"%PDF-"), "PDF output invalid")


def preview(daemon, port):
    """Keep this owned fixture alive for focused browser interaction checks."""
    host_port = fixture.free_port()
    token = f"dcui_{secrets.token_hex(32)}"
    env = {**os.environ, "DEEPCODE_HOST": "127.0.0.1", "DEEPCODE_PORT": str(host_port),
        "DEEPCODE_DAEMON_HOST": "127.0.0.1", "DEEPCODE_DAEMON_PORT": str(daemon.port),
        "DEEPCODE_HOST_WEB_SPAWN_DAEMON": "0", "DEEPCODE_HOST_UI_TOKEN": token,
        "DEEPCODE_HOST_SHELL_TOKEN": daemon.token, "DEEPCODE_HOST_INSTANCE_ID": daemon.instance_id,
        "DEEPCODE_HOST_PORT": str(host_port), "DEEPCODE_GUI_DEV_PORT": str(port)}
    processes = []
    try:
        processes.append(subprocess.Popen([str(fixture.ROOT / "target/debug/achbit-host-web")], env=env, stdout=subprocess.DEVNULL))
        processes.append(subprocess.Popen(["node", "node_modules/vite/bin/vite.js", "--config", "vite.achbit-gui.config.ts", "--host", "0.0.0.0"],
            cwd=fixture.ROOT / "userspace/gui", env=env))
        print(f"[documents-e2e] Browser preview: http://127.0.0.1:{port}/ (Ctrl+C closes this fixture)", flush=True)
        while all(process.poll() is None for process in processes):
            threading.Event().wait(1)
        raise RuntimeError("Preview process exited")
    except KeyboardInterrupt:
        pass
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview-port", type=int)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="achbit-documents-e2e-") as scratch:
        root = Path(scratch)
        workspace = root / "workspace"
        workspace.mkdir()
        state = State()
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.provider_state = state
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        daemon = fixture.OwnedDaemon(root / "config")
        try:
            fixture.write_configuration(daemon.config_root, f"http://127.0.0.1:{server.server_port}/v1", {"agent.permissions.workspaceMutation": "allow"})
            daemon.start()
            session = fixture.create_session(daemon, workspace)
            fixture.cli(daemon, session["sessionId"], "请将报告排版为 HTML、PDF 和 Markdown。")
            state.assert_healthy()
            require(state.calls == 3 and len(state.title_requests) == 1, "Document Agent turns and auxiliary title request were not independently served")
            verify_resources(daemon, fixture.projection(daemon, session["sessionId"]), workspace)
            print("[documents-e2e] PASS: actual CLI, built-in Skill, HTML/PDF/Markdown tools, artifacts, resource bytes, and continuation after a read failure (fixture Provider)", flush=True)
            if args.preview_port:
                preview(daemon, args.preview_port)
            daemon.shutdown()
        except BaseException:
            state.assert_healthy()
            print(daemon.log_tail())
            raise
        finally:
            daemon.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    main()
