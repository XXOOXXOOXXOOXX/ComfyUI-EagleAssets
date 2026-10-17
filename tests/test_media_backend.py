"""Real bounded media decoding, snapshot sidecars, and typed optional outputs."""
import importlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import torch

from fixture import Fixture


class MediaCodecTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.fixture = Fixture(cls.temp.name, media=True)
        cls.core = importlib.import_module("eagle_assets_fixture.core")
        cls.nodes = importlib.import_module("eagle_assets_fixture.nodes")
        cls.runtime = importlib.import_module("eagle_assets_fixture.runtime")
        cls.items = []
        for source in cls.fixture.items:
            if source["id"].startswith("media_"):
                item = dict(source)
                item["_path"] = str(cls.core.original_path(cls.fixture.library, item))
                cls.items.append(item)

    @classmethod
    def tearDownClass(cls):
        cls.fixture.close()
        cls.temp.cleanup()

    def test_real_decoded_video_audio_and_model_payloads(self):
        settings = {"video_max_seconds": 2, "audio_max_seconds": 1}
        video = self.core.bundle_from_items(self.items, "video", settings)
        frames = self.nodes.EagleVideoSplit().split(video, 3)
        self.assertEqual(video.media_type, "video")
        self.assertEqual(tuple(frames[0].shape), (48, 64, 80, 3))
        self.assertEqual(frames[0].dtype, torch.float32)
        self.assertIsNone(frames[2])
        self.assertTrue(0 <= frames[0].min() <= frames[0].max() <= 1)
        audio = self.core.bundle_from_items(self.items, "audio", settings)
        sounds = self.nodes.EagleAudioSplit().split(audio, 3)
        self.assertEqual(sounds[0]["waveform"].ndim, 3)
        self.assertEqual(sounds[0]["waveform"].shape[-1], sounds[0]["sample_rate"])
        self.assertGreater(sounds[0]["waveform"].abs().max(), 0)
        self.assertIsNone(sounds[2])
        models = self.core.bundle_from_items(self.items, "model", settings)
        paths = self.nodes.EagleModelSplit().split(models, 9)
        self.assertIsInstance(paths[0], str)
        self.assertTrue(Path(paths[0]).is_file())
        self.assertTrue(all(item is None for item in paths[2:]))

    def test_time_bounds_and_explicit_frame_overflow(self):
        item = next(item for item in self.items if item["id"] == "media_video")
        frames = self.core.load_video(item["_path"], {"video_start_seconds": 1, "video_max_seconds": 0.5})
        self.assertEqual(frames.shape[0], 12)
        with self.assertRaisesRegex(self.core.EagleError, "360"):
            self.core.load_video(item["_path"], {"video_fps": 60, "video_max_seconds": 15})
        with self.assertRaises(self.core.EagleError):
            self.core.load_video(item["_path"], {"video_start_seconds": 10, "video_max_seconds": 1})
        for value in [0, True, float("nan"), "24"]:
            with self.assertRaises(self.core.EagleError):
                self.core.decoder_settings({"video_fps": value})

    def test_phone_video_rotation_preserves_display_orientation(self):
        item = next(item for item in self.items if item["id"] == "media_video")
        target = Path(self.temp.name) / "rotated.mp4"
        self.core._run_ffmpeg(["-y", "-display_rotation:v:0", "90", "-i", item["_path"], "-c", "copy", str(target)])
        frames = self.core.load_video(target, {"video_max_seconds": 2})
        self.assertEqual(tuple(frames.shape), (48, 80, 64, 3))

    def test_snapshot_preserves_media_bytes_and_model_materials(self):
        items = [item for item in self.items if item["id"] in {"media_video", "media_audio", "media_model"}]
        store = self.runtime.snapshot_store()
        locked = store.create(items, {"video_max_seconds": 2, "audio_max_seconds": 1})
        copied, config = store.items(locked["snapshot_id"])
        self.assertEqual(config["video_max_seconds"], 2)
        for original, saved in zip(items, copied):
            self.assertEqual(Path(original["_path"]).read_bytes(), Path(saved["_path"]).read_bytes())
        model = next(item for item in copied if item["id"] == "media_model")
        self.assertTrue((Path(model["_path"]).parent / "model.mtl").is_file())
        data = {"version": 1, "locked": locked, "video_max_seconds": 60, "video_fps": 60}
        result = self.nodes.EagleMediaImport().load(json.dumps(data), "missing")
        self.assertEqual([len(bundle.items) for bundle in result["result"][:4]], [0, 1, 1, 1])
        reference = result["result"][4]
        self.assertIsInstance(reference, dict)
        self.assertEqual(reference["snapshot_id"], locked["snapshot_id"])
        self.assertTrue(all(isinstance(item, dict) and not any(isinstance(value, torch.Tensor) for value in item.values()) for item in reference["items"]))
        self.assertEqual(result["result"][1].items[0].value.shape[0], 48)
        self.assertTrue(all(item["media_type"] in {"video", "audio", "model"} for item in result["ui"]["eagle_assets"][0]))

    def test_models_reject_outside_resources_and_keep_valid_texture(self):
        root = Path(self.temp.name) / "model_resources"
        root.mkdir(exist_ok=True)
        outside = root.parent / "outside.bin"
        outside.write_bytes(b"outside")
        model = root / "asset.gltf"
        model.write_text(json.dumps({"buffers": [{"uri": "../outside.bin"}]}), encoding="utf-8")
        with self.assertRaises(self.core.EagleError):
            self.core.validate_model_resources(model)
        texture = root / "texture.png"
        texture.write_bytes(b"sidecar")
        model.write_text(json.dumps({"images": [{"uri": "texture.png"}]}), encoding="utf-8")
        self.core.validate_model_resources(model)
        model.write_text(json.dumps({"images": [{"uri": "https://example.com/image.png"}]}), encoding="utf-8")
        with self.assertRaises(self.core.EagleError):
            self.core.validate_model_resources(model)

    def test_preview_catalog_does_not_decode_full_media(self):
        with patch.object(self.core, "load_video", side_effect=AssertionError("full video decoded")), \
             patch.object(self.core, "load_audio", side_effect=AssertionError("full audio decoded")):
            descriptors = [self.runtime.preview_item(item) for item in self.items]
        for descriptor in descriptors:
            if descriptor["media_type"] in {"video", "audio"}:
                self.assertTrue(descriptor["media_url"].startswith("/eagle_assets/media/"))
                path, mime = self.runtime.media_file(descriptor["media_url"].rsplit("/", 1)[-1])
                self.assertTrue(path.is_file())
                self.assertTrue(mime.startswith(descriptor["media_type"] + "/"))
        with self.assertRaises(self.core.EagleError):
            self.runtime.media_file("../outside")

    def test_type_mismatch_and_empty_file3d_without_modern_comfy(self):
        empty_audio = self.core.AssetBundle((), "audio")
        self.assertTrue(all(value is None for value in self.nodes.EagleAudioSplit().split(empty_audio, 3)))
        with self.assertRaises(self.core.EagleError):
            self.nodes.EagleVideoSplit().split(empty_audio, 3)
        self.assertEqual(self.nodes.EagleModelToFile3D().convert(None), (None,))
        path = next(item["_path"] for item in self.items if item["id"] == "media_model")
        with self.assertRaisesRegex(self.core.EagleError, "FILE_3D"):
            self.nodes.EagleModelToFile3D().convert(path)

    def test_configuration_and_connected_tag_parsing(self):
        self.assertEqual(self.core.configured_folders({"folder_id": "legacy"}), ["legacy"])
        self.assertEqual(self.core.configured_folders({"folder_count": 3, "folder_ids": ["a", "b", "a"]}), ["a", "b"])
        for value in [{"folder_count": 3, "folder_ids": ["a", "b"]}, {"folder_count": 0, "folder_ids": []}]:
            with self.assertRaises(self.core.EagleError):
                self.core.configured_folders(value)
        self.assertEqual(self.nodes.parse_tags('["long prompt, including commas", "tag", "tag"]'), ["long prompt, including commas", "tag"])
        self.assertEqual(self.nodes.parse_tags("one,two\nthree"), ["one", "two", "three"])


if __name__ == "__main__":
    unittest.main()
