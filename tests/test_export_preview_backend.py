import importlib
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import torch
from PIL import Image

from fixture import Fixture


class ExportPreviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.fixture = Fixture(cls.temp.name, media=True)
        cls.nodes = importlib.import_module("eagle_assets_fixture.nodes")
        cls.exports = importlib.import_module("eagle_assets_fixture.media_export")
        cls.runtime = importlib.import_module("eagle_assets_fixture.runtime")
        cls.core = importlib.import_module("eagle_assets_fixture.core")

    @classmethod
    def tearDownClass(cls):
        cls.fixture.close()
        cls.temp.cleanup()

    def test_images_keep_native_descriptors_and_original_pixels_for_assets(self):
        images = torch.linspace(.1, .9, 24 * 32 * 3).reshape(1, 24, 32, 3).repeat(2, 1, 1, 1)
        for output in (False, True):
            result = self.nodes.EagleAssetExport().save(images, settings=json.dumps(self.fixture.settings(save_output=output, save_eagle=False)))
            ui = result["ui"]
            self.assertEqual(len(ui["images"]), 2)
            for native, custom in zip(ui["images"], ui["eagle_media"][0]):
                self.assertEqual(native, {key: custom[key] for key in ("filename", "subfolder", "type")})
                path = Path(self.temp.name) / native["type"] / native["subfolder"] / native["filename"]
                with Image.open(path) as image:
                    np.testing.assert_allclose(np.asarray(image) / 255, images[0].numpy(), atol=1 / 255)

    def test_models_restore_registered_resources_after_registry_loss(self):
        for output in (False, True):
            source = self.core.original_path(self.fixture.library, next(item for item in self.fixture.items if item["id"] == "media_model"))
            result = self.exports.EagleModelExport().save(path=str(source), settings=json.dumps(self.fixture.settings(save_output=output)))
            item = result["ui"]["eagle_media"][0][0]
            self.runtime._model_files.clear()
            restored = self.runtime.restore_export_preview(item)["model_url"]
            model_id, resource = restored.split("/", 4)[3:]
            path, _ = self.runtime.model_resource(model_id, resource)
            self.assertEqual(path.read_bytes(), source.read_bytes())

    def test_model_restore_rejects_external_paths_and_unrelated_files(self):
        for descriptor in (None, {}, {"filename": "x.obj", "type": "input"},
                           {"filename": "../x.obj", "type": "temp"},
                           {"filename": "x.obj", "subfolder": "../output", "type": "temp"},
                           {"filename": "x.obj", "subfolder": "C:/Windows", "type": "output"},
                           {"filename": "missing.obj", "type": "output"}):
            with self.subTest(descriptor=descriptor), self.assertRaises(self.core.EagleError):
                self.runtime.restore_export_preview(descriptor)


if __name__ == "__main__":
    unittest.main()
