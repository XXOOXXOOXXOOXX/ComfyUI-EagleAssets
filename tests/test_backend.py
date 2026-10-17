import ast
import importlib
import json
import math
from pathlib import Path
import tempfile
import types
import unittest

import torch
from PIL import Image

from fixture import Fixture


class BackendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(); cls.fixture = Fixture(cls.temp.name)
        cls.core = importlib.import_module("eagle_assets_fixture.core")
        cls.runtime = importlib.import_module("eagle_assets_fixture.runtime")
        cls.nodes = importlib.import_module("eagle_assets_fixture.nodes")
    @classmethod
    def tearDownClass(cls):
        cls.fixture.close(); cls.temp.cleanup()

    def test_01_directories_children_and_limits(self):
        client = self.core.EagleClient(self.fixture.host)
        ctx = client.context()
        self.assertEqual([folder["path"] for folder in ctx["folders"]], ["Assets", "Assets / Actors", "Results"])
        _, items = client.catalog("assets", 2, True)
        self.assertEqual(len(items), 2)
        _, items = client.catalog("assets", 20, False)
        self.assertNotIn("4", [item["name"] for item in items])
        _, items = client.catalog("assets", 20, True)
        self.assertIn("4", [item["name"] for item in items])
        with self.assertRaises(self.core.EagleError): client.catalog("", 20)
        with self.assertRaises(self.core.EagleError): client.catalog("assets", 0)
        with self.assertRaises(self.core.EagleError): client.catalog("assets", 20, expected_library="wrong-library")

    def test_02_multiname_exact_matches_and_order(self):
        items = self.fixture.items
        selected = self.core.select_items(items, "3/1/2.png/3")
        self.assertEqual([item["name"] for item in selected], ["3", "1", "2"])
        self.assertEqual(len(self.core.select_items(items, "1")), 1)
        self.assertEqual(len(self.core.select_items(items, "1", match_mode="contains")), 2)
        with self.assertRaisesRegex(self.core.EagleError, "未找到"):
            self.core.select_items(items, "not-found")
        self.assertEqual(self.core.select_items(items, ""), [])

    def test_03_unlocked_reload_and_script_query(self):
        raw = json.dumps(self.fixture.settings())
        node = self.nodes.EagleAssetImport()
        before = self.fixture.counts["item/list"]
        first = node.load(raw, "3/1")["result"][0]
        second = node.load(raw, "2")["result"][0]
        self.assertEqual([a.metadata["name"] for a in first.items], ["3", "1"])
        self.assertEqual([a.metadata["name"] for a in second.items], ["2"])
        self.assertEqual(self.fixture.counts["item/list"], before + 2)
        self.assertTrue(math.isnan(node.IS_CHANGED(raw)))
        self.assertEqual(len(node.load(raw, "")["result"][0].items), 0)

    def test_04_snapshot_survives_refresh_source_changes_and_query(self):
        data = self.fixture.settings()
        catalog = self.runtime.prepare_catalog(data)
        locked = self.runtime.lock_catalog(catalog["catalog_id"], data, ["asset0", "asset1"])
        data["locked"] = locked
        raw = json.dumps(data); node = self.nodes.EagleAssetImport()
        before = node.load(raw, "4")["result"][0]
        path = self.fixture.library / "images" / "asset0.info" / "1.png"
        original = path.read_bytes()
        try:
            Image.new("RGB", (64, 64), (255, 0, 0)).save(path)
            self.runtime.prepare_catalog(data)
            after = node.load(raw, "3")["result"][0]
            self.assertEqual([a.metadata["id"] for a in after.items], ["asset0", "asset1"])
            self.assertTrue(torch.equal(before.items[0].image, after.items[0].image))
            self.assertEqual(node.IS_CHANGED(raw), locked["snapshot_id"])
            data["locked"] = None
            changed = node.load(json.dumps(data), "1")["result"][0]
            self.assertFalse(torch.equal(before.items[0].image, changed.items[0].image))
        finally: path.write_bytes(original)

    def test_05_sort_and_split_heterogeneous_assets(self):
        bundle = self.nodes.EagleAssetImport().load(json.dumps(self.fixture.settings()), "3/1/2")["result"][0]
        manual = self.core.sort_bundle(bundle, "manual", ["asset1", "asset0"])
        self.assertEqual([a.metadata["name"] for a in manual.items], ["2", "1", "3"])
        ordered = self.core.sort_bundle(bundle, "name")
        self.assertEqual([a.metadata["name"] for a in ordered.items], ["1", "2", "3"])
        split = self.nodes.EagleAssetSplit().split(ordered, 9)
        self.assertEqual(len(split), 64)
        self.assertEqual(tuple(split[0].shape), (1, 64, 64, 3))
        self.assertEqual(tuple(split[1].shape), (1, 72, 80, 3))
        self.assertTrue(all(value is None for value in split[3:]))
        with self.assertRaisesRegex(self.core.EagleError, "避免丢失"):
            self.nodes.EagleAssetSplit().split(ordered, 2)

    def test_06_export_independent_switches_and_preview(self):
        node = self.nodes.EagleAssetExport(); image = torch.zeros((1, 64, 64, 3))
        root = Path(self.temp.name)
        for eagle, output in [(False, False), (True, False), (False, True), (True, True)]:
            before_exports = len(self.fixture.exports); before_output = len(list((root / "output").iterdir()))
            data = self.fixture.settings(folder_id="results", save_eagle=eagle, save_output=output)
            result = node.save(image, settings=json.dumps(data), prompt={"inputs": {"settings": json.dumps({"token": "must-not-leak"})}})
            self.assertNotIn("images", result["ui"], "native and custom image previews must not both render")
            descriptors = result["ui"]["eagle_media"][0]
            self.assertEqual(len(descriptors), 1)
            self.assertEqual(descriptors[0]["type"], "output" if output else "temp")
            self.assertEqual(len(self.fixture.exports) - before_exports, int(eagle))
            self.assertEqual(len(list((root / "output").iterdir())) - before_output, int(output))
            if eagle:
                self.assertEqual(self.fixture.exports[-1]["folderId"], "results")
                with Image.open(self.fixture.exports[-1]["items"][0]["path"]) as saved:
                    self.assertNotIn("must-not-leak", saved.info.get("prompt", ""))
        empty = node.save(None, settings=json.dumps(self.fixture.settings(save_eagle=True, save_output=True)))
        self.assertEqual(empty["ui"]["eagle_media"], [[]])

    def test_07_stale_preview_cannot_be_locked_in_other_folder(self):
        data = self.fixture.settings(); catalog = self.runtime.prepare_catalog(data)
        data["folder_id"] = "results"
        with self.assertRaisesRegex(self.core.EagleError, "变化"):
            self.runtime.lock_catalog(catalog["catalog_id"], data, ["asset0"])

    def test_08_invalid_snapshot_paths_and_malformed_settings(self):
        with self.assertRaises(self.core.EagleError): self.runtime.snapshot_store().load("../outside")
        for raw in ["null", "{}", "bad-json"]:
            with self.assertRaises(self.core.EagleError): self.core.parse_settings(raw)

    def test_09_export_into_input_folder_refresh_keeps_snapshot(self):
        data = self.fixture.settings()
        before = self.runtime.prepare_catalog(data)
        locked = self.runtime.lock_catalog(before["catalog_id"], data, ["asset0"])
        data["locked"] = locked
        original = self.nodes.EagleAssetImport().load(json.dumps(data))["result"][0]
        output_settings = self.fixture.settings(save_eagle=True, save_output=False)
        self.nodes.EagleAssetExport().save(torch.ones((1, 64, 64, 3)), settings=json.dumps(output_settings))
        refreshed = self.runtime.prepare_catalog(data)
        self.assertEqual(len(refreshed["items"]), len(before["items"]) + 1)
        result = self.nodes.EagleAssetImport().load(json.dumps(data), "4")["result"][0]
        self.assertEqual(result.items[0].metadata["id"], "asset0")
        self.assertTrue(torch.equal(original.items[0].image, result.items[0].image))


class UpstreamCompatibilityTests(unittest.TestCase):
    """Run actual downloaded upstream function bodies; no models or GPU inference required."""
    def test_t8_real_autogrow_skips_none(self):
        path = Path(__file__).parents[2] / ".research-eagle" / "t8_core.py"
        if not path.exists(): self.skipTest("upstream research source not present")
        tree = ast.parse(path.read_text(encoding="utf-8"))
        functions = [item for item in tree.body if isinstance(item, ast.FunctionDef) and item.name in {"sorted_autogrow_items", "sorted_autogrow_values"}]
        module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), *functions], type_ignores=[])
        namespace = {}; exec(compile(ast.fix_missing_locations(module), str(path), "exec"), namespace)
        image = torch.zeros((1, 64, 64, 3))
        refs = {f"ref_image_{i}": image if i <= 3 else None for i in range(1, 10)}
        self.assertEqual(len(namespace["sorted_autogrow_values"](refs)), 3)
        self.assertEqual(namespace["sorted_autogrow_values"]({key: None for key in refs}), [])

    def test_official_qwen21_real_execute_skips_none(self):
        path = Path(__file__).parents[2] / ".research-eagle" / "qwen_nodes.py"
        if not path.exists(): self.skipTest("upstream research source not present")
        tree = ast.parse(path.read_text(encoding="utf-8"))
        cls = next(item for item in tree.body if isinstance(item, ast.ClassDef) and item.name == "TextEncodeQwenImage21")
        execute = next(item for item in cls.body if isinstance(item, ast.FunctionDef) and item.name == "execute")
        cls.body = [execute]; cls.bases = []
        module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), cls], type_ignores=[])
        class Clip:
            def __init__(self): self.counts = []
            def tokenize(self, prompt, images, **kwargs): self.counts.append(len(images)); return prompt
            def encode_from_tokens_scheduled(self, tokens): return tokens
        comfy = types.SimpleNamespace(utils=types.SimpleNamespace(common_upscale=lambda tensor, w, h, *args: torch.nn.functional.interpolate(tensor, size=(h, w), mode="nearest")),
            model_management=types.SimpleNamespace(intermediate_device=lambda: "cpu"))
        namespace = {"torch": torch, "math": math, "comfy": comfy, "io": types.SimpleNamespace(NodeOutput=lambda *args: args)}
        exec(compile(ast.fix_missing_locations(module), str(path), "exec"), namespace)
        clip = Clip(); image = torch.zeros((1, 64, 64, 3))
        refs = {f"image_{i}": image if i <= 3 else None for i in range(1, 10)}
        outputs = namespace["TextEncodeQwenImage21"].execute(clip, "positive", "negative", resolution=64, images=refs)
        self.assertEqual(clip.counts, [3, 3]); self.assertEqual(outputs[2]["samples"].shape[-2:], (4, 4))
        clip.counts.clear()
        namespace["TextEncodeQwenImage21"].execute(clip, "positive", "negative", resolution=64, images={key: None for key in refs})
        self.assertEqual(clip.counts, [0, 0])


if __name__ == "__main__": unittest.main()
