import importlib
import tempfile
import unittest
from pathlib import Path
from fixture import Fixture

class ViewerBackendTests(unittest.TestCase):
    def test_export_association_excludes_older_items_with_the_same_name(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(directory, media=True)
            try:
                core = importlib.import_module("eagle_assets_fixture.core")
                runtime = importlib.import_module("eagle_assets_fixture.runtime")
                original = next(item for item in fixture.items if item["id"] == "media_image")
                source = core.original_path(fixture.library, original)
                client = core.EagleClient(fixture.host)
                client.export_paths([source], [original["name"]], "media_mix")
                self.assertIn(original["id"], client.last_export_excludes[0])
                self.assertNotEqual(client.last_export_items[0]["id"], original["id"])
                settings = {**fixture.settings(), "folder_id": "media_mix", "library_key": client.last_export_library_key}
                resolved = runtime.resolve_export_item(settings, original["name"], "png", client.last_export_excludes[0])["item"]
                self.assertNotEqual(resolved["id"], original["id"])
                runtime.inspect_eagle_item(settings, resolved["id"], "仅修改新导出素材")
                self.assertEqual(original["name"], "picture")
            finally:
                fixture.close()
    def test_legacy_http_rename_uses_local_companion_and_verifies_result(self):
        import json, os, threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(directory, media=True)
            core = importlib.import_module("eagle_assets_fixture.core")
            runtime = importlib.import_module("eagle_assets_fixture.runtime")
            class LegacyClient(core.EagleClient):
                def request(self, endpoint, params=None, payload=None):
                    return None if endpoint == "item/update" else super().request(endpoint, params, payload)
            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *args): pass
                def do_POST(self):
                    data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    assert self.headers["X-Eagle-Assets-Token"] == "a" * 64
                    assert data["library_path"] == str(fixture.library.resolve())
                    core.EagleClient(fixture.host).request("item/update", payload={"id": data["id"], "name": data["name"]})
                    self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true}')
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
            connection = Path(directory) / "EagleAssetsBridge" / "connection.json"; connection.parent.mkdir()
            connection.write_text(json.dumps({"port": server.server_address[1], "token": "a" * 64}), encoding="utf-8")
            try:
                with patch.dict(os.environ, {"LOCALAPPDATA": directory, "XDG_CONFIG_HOME": directory}), patch.object(runtime, "client_for", lambda settings: LegacyClient(fixture.host)):
                    if os.name == "nt" or os.sys.platform != "darwin":
                        result = runtime.inspect_eagle_item(fixture.settings(), "media_image", "服务同步名")
                        self.assertEqual(result["item"]["name"], "服务同步名")
            finally:
                server.shutdown(); server.server_close(); worker.join(2); fixture.close()

    def test_original_image_preview_annotation_and_verified_rename(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(directory, media=True)
            try:
                runtime = importlib.import_module("eagle_assets_fixture.runtime")
                settings = fixture.settings(folder_count=1, folder_ids=["media_mix"], types=["image"])
                catalog = runtime.prepare_catalog(settings)
                item = next(item for item in catalog["items"] if item["id"] == "media_image")
                self.assertTrue(item["media_url"])
                path, mime = runtime.media_file(item["media_url"].split("/")[-1])
                self.assertEqual(Path(path).suffix, ".png"); self.assertTrue(mime.startswith("image/"))
                original = next(item for item in fixture.items if item["id"] == "media_image")
                original["annotation"] = "完整的 Eagle 注释"
                info = runtime.inspect_eagle_item(settings, "media_image")["item"]
                self.assertEqual(info["annotation"], original["annotation"])
                renamed = runtime.inspect_eagle_item(settings, "media_image", "素材新名字")["item"]
                self.assertEqual(renamed["name"], "素材新名字")
                self.assertTrue(runtime.media_file(item["media_url"].split("/")[-1])[0].is_file())
                self.assertEqual(runtime.studio_catalog(catalog_id=catalog["catalog_id"])["items"][0]["name"], "素材新名字")
                with self.assertRaises(ValueError): runtime.inspect_eagle_item(settings, "media_image", "../bad")
                with self.assertRaises(ValueError): runtime.inspect_eagle_item({**settings, "library_key": "other-library"}, "media_image", "不应修改")
            finally:
                fixture.close()
