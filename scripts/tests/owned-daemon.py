#!/usr/bin/env python3
"""The E2E fixture releases its own group even after the daemon leader exits."""
import ctypes
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import unittest

spec = importlib.util.spec_from_file_location("deepcode_test_support", Path(__file__).with_name("support.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class OwnedDaemonTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "linux", "orphan reaping fixture requires Linux")
    def test_exited_leader_does_not_abandon_a_live_descendant(self):
        libc = ctypes.CDLL(None, use_errno=True)
        previous = ctypes.c_int()
        self.assertEqual(libc.prctl(37, ctypes.byref(previous), 0, 0, 0), 0)
        self.assertEqual(libc.prctl(36, 1, 0, 0, 0), 0)
        descendant = None
        reaper = None
        reaped = []
        with tempfile.TemporaryDirectory(prefix="deepcode-owned-daemon-") as directory:
            daemon = fixture.OwnedDaemon(Path(directory))
            try:
                daemon.process = subprocess.Popen([
                    sys.executable, "-c",
                    "import os,signal,time\n"
                    "if os.fork(): os._exit(7)\n"
                    "signal.signal(signal.SIGTERM,signal.SIG_IGN)\n"
                    "print(os.getpid(),flush=True)\n"
                    "time.sleep(60)\n",
                ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
                descendant = int(daemon.process.stdout.readline())
                self.assertEqual(daemon.process.wait(timeout=3), 7)
                # Act as the orphan's init: reap it once cleanup terminates it.
                reaper = threading.Thread(target=lambda: reaped.append(os.waitpid(descendant, 0)))
                reaper.start()
                daemon.close()
                reaper.join(timeout=3)
                self.assertFalse(reaper.is_alive(), "cleanup must release the descendant")
                self.assertEqual(reaped[0][0], descendant)
                self.assertEqual(os.waitstatus_to_exitcode(reaped[0][1]), -signal.SIGKILL)
                with self.assertRaises(ProcessLookupError):
                    os.killpg(daemon.process.pid, 0)
                daemon.terminate_group()  # An already-released group is a valid completion race.
            finally:
                if daemon.process is not None:
                    try:
                        os.killpg(daemon.process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    daemon.process.wait(timeout=3)
                    daemon.process.stdout.close()
                if reaper is not None:
                    reaper.join(timeout=3)
                elif descendant is not None:
                    os.waitpid(descendant, 0)
                daemon.log_file.close()
                self.assertEqual(libc.prctl(36, previous.value, 0, 0, 0), 0)


if __name__ == "__main__":
    unittest.main()
