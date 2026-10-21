import importlib
import json
from pathlib import Path
import tempfile
import unittest
import torch
from fixture import Fixture


class ExportChainTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.fixture = Fixture(cls.temp.name, media=True)
        cls.nodes = importlib.import_module("eagle_assets_fixture.nodes")
        cls.exports = importlib.import_module("eagle_assets_fixture.media_export")
        cls.core = importlib.import_module("eagle_assets_fixture.core")
        cls.targets = importlib.import_module("eagle_assets_fixture.export_target")

    @classmethod
    def tearDownClass(cls):
        cls.fixture.close(); cls.temp.cleanup()

    def test_real_mixed_exports_share_destination_and_keep_individual_metadata(self):
        head = json.dumps(self.fixture.settings(folder_id="results", save_eagle=True, save_output=False, tags="head", annotation="第一张"))
        own = json.dumps(self.fixture.settings(host="http://127.0.0.1:1", folder_id="not-real", save_eagle=False, save_output=True, tags="own", annotation="本节点"))
        images = torch.zeros((1, 16, 24, 3))
        before = len(self.fixture.exports)
        first = self.nodes.EagleAssetExport().save(images, settings=head)
        target = first["result"][0]
        second = self.nodes.EagleAssetExport().save(images + .5, filename_prefix="chain/second", settings=own, eagle_target=target, tags="第二张", annotation="独立注释")
        audio = {"waveform": torch.zeros((1, 1, 2400)), "sample_rate": 24000}
        third = self.exports.EagleAudioExport().save(audio, settings=own, eagle_target=second["result"][0])
        fourth = self.exports.EagleVideoExport().save(frames=images.repeat(2, 1, 1, 1), settings=own, eagle_target=third["result"][0])
        path = self.core.original_path(self.fixture.library, next(item for item in self.fixture.items if item["id"] == "media_model"))
        fifth = self.exports.EagleModelExport().save(path=str(path), settings=own, eagle_target=fourth["result"][0])
        records = self.fixture.exports[before:]
        self.assertEqual(len(records), 5)
        self.assertEqual({record["folderId"] for record in records}, {"results"})
        self.assertEqual(records[1]["items"][0]["tags"], ["第二张"])
        self.assertEqual(records[1]["items"][0]["annotation"], "独立注释")
        self.assertEqual(records[2]["items"][0]["annotation"], "本节点")
        self.assertEqual(second["ui"]["eagle_media"][0][0]["type"], "output")
        self.assertEqual(first["ui"]["eagle_media"][0][0]["type"], "temp")
        self.assertEqual(fifth["result"][0]["folder_id"], "results")
        self.assertTrue(target["library_key"])
        self.assertNotIn("annotation", target)
        self.assertNotIn("save_output", target)
        self.assertNotIn("filename_prefix", target)

    def test_all_export_ports_and_empty_media_preserve_chain(self):
        target = {"version": 1, "host": "bridge://" + "a" * 32, "folder_id": "folder", "save_eagle": True, "token": "secret", "_bridge_auth": "scoped"}
        entries = [(self.nodes.EagleAssetExport, {"images": None}), (self.exports.EagleAudioExport, {"audio": None}), (self.exports.EagleVideoExport, {}), (self.exports.EagleModelExport, {})]
        for cls, kwargs in entries:
            self.assertEqual(cls.INPUT_TYPES()["optional"]["eagle_target"][0], "EAGLE_EXPORT_TARGET")
            self.assertEqual(cls.RETURN_TYPES, ("EAGLE_EXPORT_TARGET",))
            result = cls().save(**kwargs, eagle_target=target)
            target = result["result"][0]
            self.assertEqual(target["folder_id"], "folder")
            self.assertEqual(target["token"], "secret")
            self.assertEqual(target["_bridge_auth"], "scoped")
            self.assertEqual(result["ui"]["eagle_media"], [[]])

    def test_upstream_off_and_bad_target_and_library_switch(self):
        own = self.fixture.settings(folder_id="results", save_eagle=True)
        disabled = self.targets.resolve_target(own, {"version": 1, "host": self.fixture.host, "folder_id": "results", "save_eagle": False})
        self.assertFalse(disabled["save_eagle"])
        with self.assertRaises(self.core.EagleError):
            self.nodes.EagleAssetExport().save(torch.zeros((1, 2, 2, 3)), settings=json.dumps(own), eagle_target={"version": 1, "host": self.fixture.host, "folder_id": "results", "save_eagle": True, "library_key": "old-library"})
        with self.assertRaises(self.core.EagleError):
            self.exports.EagleAudioExport().save(None, eagle_target="not-a-target")


if __name__ == "__main__":
    unittest.main()
