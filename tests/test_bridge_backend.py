"""Regressions for stale bridge selections and snapshot/live preview separation."""
import importlib
import json
import tempfile
import unittest

from fixture import Fixture


class BridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.fixture = Fixture(cls.temp.name)
        cls.runtime = importlib.import_module("eagle_assets_fixture.runtime")
        cls.nodes = importlib.import_module("eagle_assets_fixture.nodes")
        cls.core = importlib.import_module("eagle_assets_fixture.core")

    @classmethod
    def tearDownClass(cls):
        cls.fixture.close()
        cls.temp.cleanup()

    def publish(self, reference, ids):
        return self.nodes.EagleStudioBridge().publish(reference, json.dumps({"version": 1, "selected_ids": ids}))

    def test_stale_selections_skip_without_changing_valid_click_order(self):
        catalog = self.runtime.prepare_catalog(self.fixture.settings())
        result = self.publish(catalog, ["gone", "asset1", "asset0", "asset1"])
        self.assertEqual([item["id"] for item in result["result"][0]["items"]], ["asset1", "asset0"])
        self.assertEqual(result["ui"]["eagle_studio_skipped_ids"], [["gone"]])
        self.assertIn("已跳过 1", result["ui"]["eagle_status"][0])
        self.assertEqual(self.publish(catalog, ["gone"])["result"][0]["items"], [])
        self.assertEqual(self.publish(catalog, [])["result"][0]["items"], [])

    def test_locked_import_refresh_does_not_expand_bridge_snapshot(self):
        settings = self.fixture.settings()
        preview = self.runtime.prepare_catalog(settings)
        settings["locked"] = self.runtime.lock_catalog(preview["catalog_id"], settings, ["asset0"])
        self.runtime.prepare_catalog(settings)  # Refresh live gallery, leaving lock intact.
        imported = self.nodes.EagleMediaImport().load(json.dumps(settings))
        reference = imported["result"][4]
        self.assertIn("snapshot_id", reference)
        result = self.publish(reference, ["asset1", "asset0"])
        self.assertEqual([item["id"] for item in result["result"][0]["items"]], ["asset0"])
        self.assertEqual(result["ui"]["eagle_studio_skipped_ids"], [["asset1"]])
        refs = [{"snapshot_id": reference["snapshot_id"], "item_id": "asset0"}]
        resolved = self.runtime.resolve_studio_media(refs)
        self.assertEqual(resolved[0]["metadata"]["id"], "asset0")

    def test_bad_selection_shapes_are_explicit_errors(self):
        reference = self.runtime.prepare_catalog(self.fixture.settings())
        for ids in ["asset0", None, {"asset0": True}, [False], [[]]]:
            with self.assertRaisesRegex(self.core.EagleError, "文字列表"):
                self.publish(reference, ids)


if __name__ == "__main__":
    unittest.main()
