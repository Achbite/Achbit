#!/usr/bin/env python3
"""Repair incompatible user plugins through the same CLI a Session uses."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile

spec = importlib.util.spec_from_file_location("support", Path(__file__).with_name("support.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


def run():
    with tempfile.TemporaryDirectory(prefix="achbit-plugin-repair-") as directory:
        root = Path(directory)
        candidate = root / "theme"
        candidate.mkdir()
        manifest = {"id": "example.custom-theme", "name": "Custom theme", "slots": ["theme"], "entry": "entry.js"}
        manifest_file = candidate / "achbit-ui.json"
        manifest_file.write_text(json.dumps(manifest))
        (candidate / "entry.js").write_text("export default { apply() {} }")
        daemon = fixture.OwnedDaemon(root / "state")

        def plugins(*args, success=True):
            call = subprocess.run(
                [str(fixture.CLI_BINARY), "--api", daemon.base_url, "--no-auto-start-kernel", "plugins", *map(str, args)],
                env=fixture.shell_environment(daemon), capture_output=True, text=True, timeout=20,
            )
            fixture.require((call.returncode == 0) == success, f"plugins {args[0]} exited {call.returncode}: {call.stderr}")
            if success:
                return json.loads(call.stdout)

        try:
            daemon.start()
            installed = Path(plugins("install", candidate)["plugin"]["path"])
            plugins("disable", installed)
            # An existing installation can declare a slot the current GUI no longer supports.
            retired = installed / "achbit-ui.json"
            retired.write_text(json.dumps({**manifest, "slots": ["retired.slot"]}))
            failed, = plugins("status", manifest["id"])["plugins"]
            assert failed["application"]["status"] == "failed" and failed["application"]["error"]
            assert failed["path"] == str(installed)

            plugins("install", candidate, success=False)
            manifest_file.write_text(json.dumps({**manifest, "id": "example.unrelated"}))
            plugins("update", installed, candidate, success=False)
            manifest_file.write_text(retired.read_text())
            plugins("update", installed, candidate, success=False)
            unchanged, = plugins("list")["plugins"]
            assert unchanged["path"] == str(installed) and not unchanged["enabled"]

            manifest_file.write_text(json.dumps(manifest))
            plugins("inspect", candidate)
            plugins("update", manifest["id"], candidate)
            repaired, = plugins("status", manifest["id"])["plugins"]
            assert repaired["path"] != str(installed) and not repaired["enabled"]
            assert repaired["slots"] == ["theme"] and not repaired.get("error")
            assert json.loads(retired.read_text())["slots"] == ["retired.slot"]
            # Legacy UI registrations store only their path; a missing ID cannot identify a replacement.
            (Path(repaired["path"]) / "achbit-ui.json").write_text("{")
            unidentified, = plugins("status", repaired["path"])["plugins"]
            assert unidentified["application"]["status"] == "failed"
            plugins("update", repaired["path"], candidate, success=False)

            tool = root / "text-tool"
            tool.mkdir()
            for filename, content in plugins("template", "cli")["content"].items():
                (tool / filename).write_text(content)
            tool_receipt = plugins("install", tool)["plugin"]
            tool_id = tool_receipt["id"]
            old_tool = Path(tool_receipt["path"])
            (old_tool / "achbit-tool.json").write_text("{")
            broken, = plugins("status", tool_id)["plugins"]
            assert broken["path"] == str(old_tool) and broken["application"]["status"] == "failed"
            plugins("update", tool_id, tool)
            working, = plugins("status", tool_id)["plugins"]
            assert working["enabled"] and working["application"]["status"] == "available"
            assert working["path"] != str(old_tool) and not working.get("error")
            print("[plugin-repair-cli] PASS: diagnosed and repaired UI and CLI plugins; invalid replacements rejected")
        finally:
            daemon.close()


if __name__ == "__main__":
    run()
