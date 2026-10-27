#!/usr/bin/env python3
"""Real conversation storage regression using an isolated Host and local Provider."""
from __future__ import annotations

from contextlib import ExitStack, closing
import http.server
import importlib.util
import json
import os
import subprocess
from pathlib import Path
import tempfile
import threading
import urllib.parse
import urllib.request

spec = importlib.util.spec_from_file_location("achbit_test_support", Path(__file__).with_name("support.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
require = fixture.require
LONG_TEXT = "  原始资料🙂\n" + "保留每一行与末尾空白。  \n" * 1200


class ProviderHandler(fixture.MockProviderHandler):
    def do_POST(self) -> None:
        try:
            require(self.path.endswith("/chat/completions"), "Unexpected Provider endpoint")
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            if self.respond_to_title(body):
                return
            self.provider_state.requests.append(body)
            self.send_response(200)
            self.send_header("content-type", "text/event-stream; charset=utf-8")
            self.send_header("connection", "close")
            self.end_headers()
            self._send_text(f"storage-message-{len(self.provider_state.requests)}")
        except BaseException as error:
            self.provider_state.record_failure(error)
            self.close_connection = True


def session_path(session_id: str) -> str:
    return "/api/conversation/sessions/" + urllib.parse.quote(session_id, safe="")


def request(daemon, path: str, *, method: str = "GET", body=None):
    return fixture.api_json(daemon.base_url, path, token=daemon.token, method=method, body=body, timeout=15)


def submit(daemon, provider, session_id: str, ordinal: int, text: str, references=()):
    catalog = request(daemon, "/api/conversation/plugins")
    reply = request(daemon, session_path(session_id) + "/commands", method="POST", body={
        "schemaVersion": fixture.COMMAND_VERSION,
        "type": "message.submit",
        "commandId": f"command:storage-{ordinal}",
        "sessionId": session_id,
        "text": text,
        "filesystemReferences": list(references),
        "pluginCatalogRevision": catalog["revision"],
        "pluginSelections": [],
    })
    require(reply.get("status") == "accepted", "Message was not accepted")
    result = fixture.wait_completed(daemon, provider, session_id, f"storage message {ordinal}")
    require(len(provider.requests) == ordinal, "Message did not reach the local Provider exactly once")
    return result


def upload(daemon, session_id: str, input_id: str, content: str):
    path = session_path(session_id) + "/input-resources/" + urllib.parse.quote(input_id, safe="")
    outgoing = urllib.request.Request(
        daemon.base_url + path, data=content.encode("utf-8"), method="POST",
        headers={"content-type": "text/plain; charset=utf-8", fixture.HOST_TOKEN_HEADER: daemon.token},
    )
    with fixture.URL_OPENER.open(outgoing, timeout=15) as response:
        return json.load(response)


def workspace_rows(config_root: Path, session_id: str):
    database = config_root / "data/agent-runtime/catalog.sqlite3"
    with closing(fixture.sqlite_read_only(database)) as connection:
        rows = connection.execute(
            "SELECT w.workspace_id, w.canonical_root, s.workspace_id IS NOT NULL "
            "FROM workspaces w LEFT JOIN session_workdirs s USING(workspace_id) "
            "WHERE w.owner_session_id = ? ORDER BY w.workspace_id", (session_id,),
        ).fetchall()
    return {identity: (Path(path), bool(working)) for identity, path, working in rows}


def is_descendant(path: Path, root: Path) -> bool:
    return any(parent.samefile(root) for parent in path.resolve().parents)


def check_session_navigation(daemon, provider, session_id: str, other_id: str, root: Path) -> None:
    # The registered CLI profile runs in the Linux development container.
    import pty
    base = ["--api", daemon.base_url, "--no-auto-start-kernel"]
    environment = fixture.shell_environment(daemon)
    before = request(daemon, "/api/conversation/catalog")
    provider_count = len(provider.requests)
    listed = subprocess.run([str(fixture.CLI_BINARY), *base, "sessions"], env=environment,
                            text=True, capture_output=True, timeout=15)
    require(listed.returncode == 0 and session_id in listed.stdout and other_id in listed.stdout,
            f"CLI did not list shared sessions: {listed.stdout}\n{listed.stderr}")
    ordered = sorted(before["sessions"], key=lambda item: item["id"])
    ordered.sort(key=lambda item: item["updatedAt"], reverse=True)
    ordinal = next(index + 1 for index, item in enumerate(ordered) if item["id"] == other_id)
    master, slave = pty.openpty()
    process = None
    try:
        process = subprocess.Popen([str(fixture.CLI_BINARY), *base, "resume", session_id],
                                   stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env=environment, text=True)
        os.close(slave)
        slave = -1
        commands = f"/sessions\n/resume {ordinal}\n/show\n/resume session:missing-navigation\n/show\n/new\n/show\n/quit\n"
        os.write(master, commands.encode())
        stdout, stderr = process.communicate(timeout=20)
        require(process.returncode == 0, f"CLI navigation failed: {stdout}\n{stderr}")
        require(other_id in stdout and "session:missing-navigation" in stderr,
                f"CLI did not open the selected Session or preserve the missing-session error: {stdout}\n{stderr}")
    finally:
        if slave >= 0:
            os.close(slave)
        os.close(master)
        if process is not None and process.poll() is None:
            process.kill()
            process.communicate()
    after = request(daemon, "/api/conversation/catalog")
    new_ids = {item["id"] for item in after["sessions"]} - {item["id"] for item in before["sessions"]}
    require(len(new_ids) == 1, "CLI /new did not create exactly one Session")
    new_id = next(iter(new_ids))
    created = request(daemon, session_path(new_id) + "/projection")
    require(not created["workspaceBindings"] and not created["messages"],
            "CLI /new copied another Session's directories or messages")
    request(daemon, session_path(new_id), method="DELETE")

    # Plain TUI exercises the same command path without creating a new draft in storage.
    workspace = root / "startup-directory"
    workspace.mkdir()
    tui = subprocess.run([str(fixture.TUI_BINARY), *base, "--language", "en-US", "-C", str(workspace)],
                         input=f"/sessions\n/resume {other_id}\n/show\n/resume session:missing-navigation\n/show\n/new\n/show\n/quit\n",
                         env=environment, text=True, capture_output=True, timeout=20)
    require(tui.returncode == 0 and other_id in tui.stdout and "New conversation ready" in tui.stdout,
            f"TUI navigation failed: {tui.stdout}\n{tui.stderr}")
    require("session:missing-navigation" in tui.stdout, "TUI hid the original missing-session error")
    require(request(daemon, "/api/conversation/catalog") == before,
            "Listing, resuming or opening an unsent TUI draft mutated the catalog")
    require(len(provider.requests) == provider_count, "Navigation unexpectedly started a Provider request")
    print("[PASS] shared CLI/TUI catalog, resume, missing target, new and no implicit execution", flush=True)


def run_storage_checks(root: Path, server, provider) -> None:
    config_root = root / "用户 数据"
    fixture.write_configuration(config_root, f"http://127.0.0.1:{server.server_port}/v1", {})
    daemons = []
    try:
        daemon = fixture.OwnedDaemon(config_root)
        daemons.append(daemon)
        daemon.start()
        created = request(daemon, "/api/conversation/sessions", method="POST", body={})
        session_id = created["sessionId"]
        require(not created.get("workspaceBindings"), "Fixture unexpectedly has a project")
        submit(daemon, provider, session_id, 1, "Create this session's working directory.")
        rows = workspace_rows(config_root, session_id)
        workdirs = [(identity, path) for identity, (path, working) in rows.items() if working]
        require(len(workdirs) == 1, "First message did not create exactly one working directory")
        workdir_id, workdir = workdirs[0]
        require(workdir.is_dir(), "Registered working directory does not exist")
        storage_root = (config_root / "data/agent-runtime").resolve()
        require(is_descendant(workdir, storage_root),
                "Working directory is outside this isolated user's runtime storage")
        saved_file = workdir / "保留 内容.txt"
        saved_file.write_text("retained across restart\n", encoding="utf-8")

        source = root / "附件 文本.txt"
        source.write_text("original attachment\n", encoding="utf-8")
        references = request(daemon, session_path(session_id) + "/filesystem-references/resolve",
                             method="POST", body={"references": [{"kind": "file", "path": str(source)}]})
        require(len(references) == 1, "File reference was not resolved")
        rows = workspace_rows(config_root, session_id)
        require(references[0]["workspaceId"] not in rows, "Original file was registered as Session-owned storage")
        with closing(fixture.sqlite_read_only(config_root / "data/agent-runtime/catalog.sqlite3")) as connection:
            address_root = connection.execute("SELECT canonical_root FROM workspaces WHERE workspace_id=?", (references[0]["workspaceId"],)).fetchone()[0]
        referenced = Path(address_root) / references[0]["logicalPath"]
        require(referenced.samefile(source), "Reference does not address the original file")
        source.write_text("changed source\n", encoding="utf-8")
        require(referenced.read_text(encoding="utf-8") == "changed source\n", "Reference does not follow the original target")

        input_id = "input:粘贴 文本"
        uploaded = upload(daemon, session_id, input_id, LONG_TEXT)
        require(uploaded.get("ok") is True, f"Upload failed: {uploaded}")
        reference = uploaded["data"]["reference"]
        require(upload(daemon, session_id, input_id, LONG_TEXT) == uploaded, "Identical upload was not idempotent")
        conflict = upload(daemon, session_id, input_id, "different content")
        require(conflict.get("ok") is False and "input_resource_identity_conflict" in conflict.get("message", ""),
                "A conflicting upload did not preserve its original error")

        second_id = request(daemon, "/api/conversation/sessions", method="POST", body={})["sessionId"]
        submit(daemon, provider, second_id, 2, "Create a separate working directory for this conversation.")
        second_content = "independent session input\n"
        second_upload = upload(daemon, second_id, input_id, second_content)
        require(second_upload.get("ok") is True, "Another Session could not use the same inputId")
        second_reference = second_upload["data"]["reference"]
        require(second_reference["referenceId"] != reference["referenceId"]
                and second_reference["workspaceId"] != reference["workspaceId"],
                "Different Sessions share an input resource identity")
        second_rows = workspace_rows(config_root, second_id)
        second_workdirs = [(identity, path) for identity, (path, working) in second_rows.items() if working]
        require(len(second_workdirs) == 1, "Second Session did not create exactly one working directory")
        second_workdir_id, second_workdir = second_workdirs[0]
        require(second_workdir.is_dir() and is_descendant(second_workdir, storage_root),
                "Second working directory is outside this isolated user's runtime storage")
        require(second_workdir_id != workdir_id, "Different Sessions share a working directory identity")
        second_saved_file = second_workdir / saved_file.name
        second_saved_file.write_text("second session content\n", encoding="utf-8")
        require(saved_file.read_text(encoding="utf-8") == "retained across restart\n",
                "Second Session overwrote the first Session's working file")
        second_text_path = second_rows[second_reference["workspaceId"]][0] / second_reference["logicalPath"]
        require(second_text_path.read_text(encoding="utf-8") == second_content, "Second input content changed")
        require(upload(daemon, session_id, input_id, LONG_TEXT) == uploaded,
                "A different Session's upload changed the original input")

        projection = submit(daemon, provider, session_id, 3, LONG_TEXT, [*references, reference])
        pasted = [item for message in projection["messages"] for item in message.get("filesystemReferences", [])
                  if item.get("source") == "pastedText"]
        require(len({item["referenceId"] for item in pasted}) == 2, "Long message did not create its own text reference")
        rows = workspace_rows(config_root, session_id)
        for item in pasted:
            path = rows[item["workspaceId"]][0] / item["logicalPath"]
            require(path.read_bytes() == LONG_TEXT.encode(), "Stored text bytes changed")
        owned_paths = [path for path, _ in rows.values()]
        second_owned_paths = [path for path, _ in second_rows.values()]
        require(rows.keys().isdisjoint(second_rows), "Session-owned workspace records overlap")
        for first_path in owned_paths:
            for second_path in second_owned_paths:
                require(not first_path.samefile(second_path)
                        and not is_descendant(first_path, second_path)
                        and not is_descendant(second_path, first_path),
                        "Different Sessions have overlapping owned storage")
        attachments_root = next(path for path, working in rows.values() if not working).parent
        daemon.shutdown()

        reopened = fixture.OwnedDaemon(config_root)
        daemons.append(reopened)
        reopened.start()
        require(saved_file.read_text(encoding="utf-8") == "retained across restart\n", "Saved file was lost")
        require(upload(reopened, session_id, input_id, LONG_TEXT) == uploaded, "Restart changed upload identity")
        require(upload(reopened, second_id, input_id, second_content) == second_upload,
                "Restart changed the second Session's input identity")
        submit(reopened, provider, session_id, 4, "Continue this same conversation.")
        reopened_rows = workspace_rows(config_root, session_id)
        require(reopened_rows == rows, "Restart or next message changed registered storage")
        require(reopened_rows[workdir_id] == (workdir, True), "Working directory was not reused")
        require(referenced.read_text(encoding="utf-8") == "changed source\n", "Restart lost the original target")
        check_session_navigation(reopened, provider, session_id, second_id, root)
        request(reopened, session_path(session_id), method="DELETE")
        require(not workspace_rows(config_root, session_id), "Session deletion retained owned catalog entries")
        require(not attachments_root.exists(), "Session deletion retained the attachment directory")
        require(all(not path.exists() for path in owned_paths), "Session deletion retained owned storage")
        require(source.read_text(encoding="utf-8") == "changed source\n", "Session deletion touched the source")
        require(workspace_rows(config_root, second_id) == second_rows,
                "Deleting one Session changed another Session's owned catalog entries")
        require(second_saved_file.read_text(encoding="utf-8") == "second session content\n"
                and second_text_path.read_text(encoding="utf-8") == second_content,
                "Deleting one Session removed another Session's files")
        request(reopened, session_path(second_id), method="DELETE")
        require(not workspace_rows(config_root, second_id) and all(not path.exists() for path in second_owned_paths),
                "Second Session deletion retained its owned storage")
        reopened.shutdown()
        provider.assert_healthy()
        print(f"[PASS] conversation storage ({os.name}): first message, original file reference, text snapshots and identities, "
              "conflict, cross-session isolation, long message, restart, reuse and owned cleanup", flush=True)
    finally:
        with ExitStack() as cleanup:
            for daemon in daemons:
                cleanup.callback(daemon.close)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="ac-storage-") as temporary:
        root = Path(temporary)
        provider = fixture.ProviderState(root)
        with http.server.ThreadingHTTPServer(("127.0.0.1", 0), ProviderHandler) as server:
            server.provider_state = provider
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                run_storage_checks(root, server, provider)
            finally:
                try:
                    server.shutdown()
                finally:
                    thread.join(timeout=5)


if __name__ == "__main__":
    main()
