"""Standalone launch, IPC preflight, isolation and focused-package regressions."""
from __future__ import annotations

import copy
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import queue
import re
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlparse
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from planar_studio import __version__
from planar_studio.app import Application, main
from planar_studio import kicad_link as k
from planar_studio.store import default_dir


class IdentityTests(unittest.TestCase):
    def test_identifiers_and_versions_are_distinct_from_upstream(self):
        metadata = json.loads((ROOT / "metadata.json").read_text())
        plugin = json.loads((ROOT / "plugin.json").read_text())
        package = json.loads((ROOT / "package.json").read_text())
        self.assertEqual(metadata["identifier"], "com.jonahsaunders.snaketransformerstudio")
        self.assertEqual(plugin["identifier"], metadata["identifier"])
        self.assertEqual(metadata["versions"][0]["version"], __version__)
        self.assertEqual(package["version"], __version__)
        self.assertEqual(package["name"], "snake-transformer-studio")

    def test_legacy_data_home_is_never_used(self):
        with patch.dict(os.environ, {"PLANAR_STUDIO_HOME": "upstream-do-not-touch"}, clear=True):
            folder = default_dir()
        self.assertNotIn("upstream-do-not-touch", folder)
        self.assertTrue("SnakeTransformerStudio" in folder or "snake-transformer-studio" in folder)

    def test_explicit_data_home_wins_over_connected_kicad(self):
        with tempfile.TemporaryDirectory() as home, patch.dict(os.environ, {"SNAKE_TRANSFORMER_STUDIO_HOME": home}), \
                patch("planar_studio.app.KiCadLink") as link:
            link.return_value.settings_dir.return_value = "unwanted"
            app = Application()
            self.assertEqual(app.store.dir, home)
            link.return_value.settings_dir.assert_not_called()

    def test_kicad_settings_path_uses_fork_identifier(self):
        link = k.KiCadLink()
        client = Mock()
        client.get_plugin_settings_path.return_value = "isolated"
        with patch.object(link, "_connect", return_value=client):
            self.assertEqual(link.settings_dir(), "isolated")
        client.get_plugin_settings_path.assert_called_once_with("com.jonahsaunders.snaketransformerstudio")

    def test_cli_forwards_headless_mode_and_port(self):
        with patch("planar_studio.app.Application") as app:
            self.assertEqual(main(["--no-browser", "--port", "8765"]), 0)
            self.assertTrue(app.return_value.start.call_args.kwargs["no_browser"])
            self.assertEqual(app.return_value.start.call_args.kwargs["port"], 8765)
        with patch("sys.stderr", new_callable=io.StringIO), self.assertRaises(SystemExit) as failure:
            main(["--port", "65536"])
        self.assertEqual(failure.exception.code, 2)

    @unittest.skipUnless(os.name == "nt", "Windows launcher is exercised on Windows")
    def test_windows_launcher_prefers_explicit_python(self):
        environment = dict(os.environ, PYTHON=sys.executable)
        result = subprocess.run(["cmd", "/d", "/c", "Start Snake Transformer Studio.cmd", "--version"],
                                cwd=ROOT, env=environment, capture_output=True, text=True, timeout=8)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Snake Transformer Studio 0.1.0", result.stdout)

    @unittest.skipUnless(os.name == "nt", "Windows launcher is exercised on Windows")
    def test_windows_launcher_can_use_existing_bundled_runtime(self):
        runtime = Path(os.environ.get("USERPROFILE", "")) / ".cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe"
        if not runtime.is_file():
            self.skipTest("Optional bundled runtime is not installed on this machine")
        environment = dict(os.environ)
        environment.pop("PYTHON", None)
        # System32 provides `where`; no Python or py directories are exposed.
        environment["PATH"] = os.path.join(os.environ["SystemRoot"], "System32")
        result = subprocess.run([os.path.join(environment["PATH"], "cmd.exe"), "/d", "/c",
                                 "Start Snake Transformer Studio.cmd", "--version"],
                                cwd=ROOT, env=environment, capture_output=True, text=True, timeout=8)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Snake Transformer Studio 0.1.0", result.stdout)


class PlacementTests(unittest.TestCase):
    def setUp(self):
        self.payload = {"tracks": [{"layer": "F.Cu", "width": 0.5, "pts": [[0, 0], [3, 4]], "net": "PRI"}]}
        self.link = k.KiCadLink()
        self.board = Mock()
        self.link._board = lambda: self.board

    def test_nonfinite_dimensions_and_malformed_geometry_are_rejected(self):
        for mutate in (
            lambda p: p.update(origin=[float("nan"), 0]),
            lambda p: p["tracks"][0].update(width=-1),
            lambda p: p["tracks"][0].update(pts=[[0, 0], [float("inf"), 0]]),
            lambda p: p["tracks"][0].update(layer="In31.Cu"),
            lambda p: p.update(vias=[{"x": 0, "y": 0, "diameter": 0.3, "drill": 0.6}]),
            lambda p: p.update(pads=[{"x": 0, "y": 0, "w": 1, "h": 1, "layer": "In1.Cu"}]),
        ):
            payload = copy.deepcopy(self.payload)
            mutate(payload)
            with self.subTest(payload=payload), self.assertRaises(k.LinkError):
                k.Placement.from_payload(payload)

    def test_disabled_layer_rejected_before_board_mutation(self):
        payload = copy.deepcopy(self.payload)
        payload["tracks"][0]["layer"] = "In2.Cu"
        with patch.object(k, "_enabled_copper_names", return_value=["F.Cu", "B.Cu"]):
            with self.assertRaisesRegex(k.LinkError, "Enable these copper layers"):
                self.link.place(k.Placement.from_payload(payload))
        self.board.begin_commit.assert_not_called()
        self.board.create_items.assert_not_called()

    def test_unmapped_net_rejected_before_board_mutation(self):
        with patch.object(k, "_enabled_copper_names", return_value=["F.Cu", "B.Cu"]), \
                patch.object(k, "_resolve_layer", return_value=1), \
                patch.object(self.link, "resolve_net", return_value=None):
            with self.assertRaisesRegex(k.LinkError, "PRI"):
                self.link.place(k.Placement.from_payload(self.payload))
        self.board.begin_commit.assert_not_called()
        self.board.create_items.assert_not_called()

    def test_unknown_board_stack_is_never_assumed_to_have_32_layers(self):
        board = object()
        self.assertEqual(k._enabled_copper_names(board), [])

    def test_preflight_accepts_verified_layers_and_named_nets(self):
        with patch.object(k, "_enabled_copper_names", return_value=["F.Cu", "B.Cu"]), \
                patch.object(k, "_resolve_layer", return_value=1), \
                patch.object(self.link, "resolve_net", return_value=object()):
            result = self.link.preflight(k.Placement.from_payload(self.payload))
        self.assertEqual(result["nets"], ["PRI"])
        self.assertEqual(result["layers"], ["F.Cu"])
        self.board.create_items.assert_not_called()

    def test_origin_is_applied_once_and_placement_is_undoable(self):
        payload = copy.deepcopy(self.payload)
        payload["origin"] = [10, 20]
        self.board.begin_commit.return_value = "undo-1"
        self.board.create_items.side_effect = lambda items: items
        vectors = SimpleNamespace(from_xy=lambda x, y: (x, y))
        with patch.object(self.link, "preflight", return_value={"ok": True}), \
                patch.object(k, "_resolve_layer", return_value=1), \
                patch.object(self.link, "resolve_net", return_value="net-object"), \
                patch.object(k, "Track", new=SimpleNamespace, create=True), \
                patch.object(k, "Vector2", new=vectors, create=True):
            result = self.link.place(k.Placement.from_payload(payload))
        track = self.board.create_items.call_args.args[0][0]
        self.assertEqual(track.start, (k.from_mm(10), k.from_mm(20)))
        self.assertEqual(track.end, (k.from_mm(13), k.from_mm(24)))
        self.assertEqual(track.net, "net-object")
        self.assertEqual(result["created"], 1)
        self.board.push_commit.assert_called_once()

    def test_partial_creation_rolls_back_the_whole_commit(self):
        self.board.begin_commit.return_value = "undo-1"
        self.board.create_items.return_value = []
        vectors = SimpleNamespace(from_xy=lambda x, y: (x, y))
        with patch.object(self.link, "preflight", return_value={"ok": True}), \
                patch.object(k, "_resolve_layer", return_value=1), \
                patch.object(self.link, "resolve_net", return_value="net-object"), \
                patch.object(k, "Track", new=SimpleNamespace, create=True), \
                patch.object(k, "Vector2", new=vectors, create=True):
            with self.assertRaisesRegex(k.LinkError, "only part"):
                self.link.place(k.Placement.from_payload(self.payload))
        self.board.drop_commit.assert_called_once_with("undo-1")
        self.board.push_commit.assert_not_called()


class StandaloneHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = tempfile.TemporaryDirectory()
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.requested_port = sock.getsockname()[1]
        environment = dict(os.environ, SNAKE_TRANSFORMER_STUDIO_HOME=cls.home.name)
        environment.pop("KICAD_API_SOCKET", None)
        environment.pop("KICAD_API_TOKEN", None)
        # -S omits site-packages: this must work with no KiCad or GUI bindings.
        cls.process = subprocess.Popen(
            [sys.executable, "-S", "ipc_entry.py", "--no-browser", "--port", str(cls.requested_port)],
            cwd=ROOT, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        lines: queue.Queue[str] = queue.Queue()
        threading.Thread(target=lambda: lines.put(cls.process.stdout.readline()), daemon=True).start()
        try:
            line = lines.get(timeout=12)
            match = re.search(r"READY (http://127\.0\.0\.1:\d+/\?t=\S+)", line)
            if not match:
                raise RuntimeError("Standalone did not print a READY URL: " + line)
            cls.url = match.group(1)
            parsed = urlparse(cls.url)
            cls.port = parsed.port
            cls.token = parse_qs(parsed.query)["t"][0]
        except Exception:
            cls.process.kill()
            cls.process.wait(timeout=5)
            cls.home.cleanup()
            raise

    @classmethod
    def tearDownClass(cls):
        try:
            conn = http.client.HTTPConnection("127.0.0.1", cls.port, timeout=5)
            conn.request("POST", "/api", json.dumps({"method": "app.quit"}), {"X-Snake-Token": cls.token})
            conn.getresponse().read()
            conn.close()
            cls.process.wait(timeout=5)
        finally:
            if cls.process.poll() is None:
                cls.process.kill()
                cls.process.wait(timeout=5)
            cls.process.stdout.close()
            cls.process.stderr.close()
            cls.home.cleanup()

    def request(self, method="GET", path="/", body=None, token=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"X-Planar-Token": token} if token else {}
        conn.request(method, path, body, headers)
        response = conn.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        conn.close()
        return result

    def rpc(self, method, params=None):
        _, _, body = self.request("POST", "/api", json.dumps({"method": method, "params": params or {}}), self.token)
        return json.loads(body)

    def test_stdlib_only_launch_is_live_on_requested_port(self):
        self.assertEqual(self.port, self.requested_port)
        self.assertEqual(self.process.poll(), None)
        self.assertEqual(self.rpc("app.info")["result"]["version"], "0.1.0")
        self.assertEqual(self.rpc("app.info")["result"]["storeDir"], self.home.name)

    def test_missing_and_invalid_auth_are_rejected(self):
        for method, path, body in (("GET", "/", None), ("GET", "/js/bridge.js", None),
                                    ("POST", "/api", '{"method":"app.info"}')):
            self.assertEqual(self.request(method, path, body)[0], 403)
            self.assertEqual(self.request(method, path, body, "incorrect")[0], 403)
        self.assertEqual(self.request(path="/healthz")[0], 200)

    def test_index_has_csp_and_separate_cookie(self):
        status, headers, body = self.request(path="/?t=" + self.token)
        self.assertEqual(status, 200)
        self.assertIn("script-src 'self'", headers["Content-Security-Policy"])
        self.assertIn("snake_token=", headers["Set-Cookie"])
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        self.assertIn("SameSite=Strict", headers["Set-Cookie"])
        self.assertNotIn(b"__PLANAR_TOKEN__", body)

    def test_no_kicad_reports_cleanly(self):
        status = self.rpc("kicad.status")
        self.assertTrue(status["ok"])
        self.assertFalse(status["result"]["connected"])
        self.assertFalse(status["result"]["kipyAvailable"])
        board = self.rpc("board.context")
        self.assertFalse(board["ok"])
        self.assertEqual(board["kind"], "nolink")
        self.assertNotIn("Traceback", board["error"])

    def test_persistence_and_exports_remain_in_isolated_home(self):
        config = {"rows": 2, "columns": 4, "nested": {"pairs": [1, 2]}}
        self.assertTrue(self.rpc("designs.save", {"id": "snake:test", "name": "Test", "config": config})["ok"])
        self.assertEqual(self.rpc("designs.load", {"id": "snake:test"})["result"]["config"], config)
        result = self.rpc("file.save", {"name": "../../sample.txt", "text": "snake\n"})
        path = Path(result["result"]["path"])
        self.assertTrue(path.is_relative_to(Path(self.home.name)))
        self.assertEqual(path.name, "sample.txt")
        self.assertEqual(path.read_text(), "snake\n")
        self.assertEqual(self.rpc("file.save", {"name": "CON", "text": "bad"})["kind"], "invalid")

    def test_malformed_rpc_objects_are_a_clean_400(self):
        for body in ("[1,2]", "null", '{"method":"app.info","params":[]}', "{bad"):
            self.assertEqual(self.request("POST", "/api", body, self.token)[0], 400)


class ArchiveTests(unittest.TestCase):
    def test_packages_have_complete_focused_runtime_and_pcm_layout(self):
        spec = importlib.util.spec_from_file_location("build_snake_package", ROOT / "scripts/build_snake_package.py")
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        with tempfile.TemporaryDirectory() as output:
            built = builder.build_packages(Path(output))
            with ZipFile(built["kicad"]) as archive:
                names = set(archive.namelist())
                self.assertIn("metadata.json", names)
                self.assertIn("plugins/plugin.json", names)
                self.assertIn("plugins/web/js/snake/app.js", names)
                self.assertIn("plugins/planar_studio/app.py", names)
                self.assertFalse(any("__pycache__" in name or "/ws/" in name or "/examples/" in name for name in names))
                self.assertNotIn("plugins/web/js/app.js", names)
                for source in builder.web_dependencies():
                    self.assertIn("plugins/" + source.relative_to(ROOT).as_posix(), names)
            with ZipFile(built["standalone"]) as archive:
                self.assertIn("snake-transformer-studio/Start Snake Transformer Studio.cmd", archive.namelist())
                self.assertIn("snake-transformer-studio/Start Snake Transformer Studio.sh", archive.namelist())
                self.assertIn("snake-transformer-studio/tests/test_snake_package.py", archive.namelist())


if __name__ == "__main__":
    unittest.main()
