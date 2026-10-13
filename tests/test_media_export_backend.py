"""Exercise real saved codecs, independent destinations and 3D resource packaging."""
import importlib
import json
from pathlib import Path
import struct
import tempfile
import types
import ast
import io
import logging
import sys
import math
import unittest
from unittest.mock import patch

import numpy as np
import torch
from PIL import Image

from fixture import Fixture


class MediaExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.fixture = Fixture(cls.temp.name, media=True)
        cls.exports = importlib.import_module("eagle_assets_fixture.media_export")
        cls.core = importlib.import_module("eagle_assets_fixture.core")
        cls.runtime = importlib.import_module("eagle_assets_fixture.runtime")
        cls.audio = {"waveform": (torch.sin(torch.arange(12000) * 2 * np.pi * 220 / 24000) * .2).reshape(1, 1, -1), "sample_rate": 24000}
        cls.video_path = cls.core.original_path(cls.fixture.library, next(item for item in cls.fixture.items if item["id"] == "media_video"))
        cls.frames = cls.core.load_video(cls.video_path, {"video_max_seconds": 2})
        cls.model_path = cls.core.original_path(cls.fixture.library, next(item for item in cls.fixture.items if item["id"] == "media_model"))

    @classmethod
    def tearDownClass(cls):
        cls.fixture.close(); cls.temp.cleanup()

    def settings(self, **overrides):
        return json.dumps(self.fixture.settings(**{"folder_id": "results", "save_eagle": False, "save_output": False, **overrides}))

    def saved_path(self, result):
        descriptor = result["ui"]["eagle_media"][0][0]
        root = Path(self.temp.name) / descriptor["type"]
        return root / descriptor["subfolder"] / descriptor["filename"]

    def test_real_audio_wav_flac_mp3_batch_and_metadata(self):
        for format in ("wav", "flac", "mp3"):
            audio = {**self.audio, "waveform": self.audio["waveform"].repeat(2, 1, 1)}
            result = self.exports.EagleAudioExport().save(audio, format=format, settings=self.settings(), filename_prefix="audio/%batch_num%",
                    prompt={"settings": json.dumps({"token": "private-token", "seed": 7})}, extra_pnginfo={"workflow": {"eagle_token": "private-token"}})
            descriptors = result["ui"]["audio"]
            self.assertEqual(len(descriptors), 2)
            self.assertTrue(descriptors[0]["filename"].startswith("0_"))
            self.assertTrue(descriptors[1]["filename"].startswith("1_"))
            saved = self.saved_path(result)
            decoded = self.core.load_audio(saved, {"audio_max_seconds": 1})
            self.assertEqual(decoded["sample_rate"], 24000 if self._av_available() else 48000)
            self.assertGreater(decoded["waveform"].abs().max(), .05)
            self.assertTrue(.45 <= decoded["waveform"].shape[-1] / decoded["sample_rate"] <= .6)
            if self._av_available():
                import av
                with av.open(str(saved)) as container:
                    self.assertNotIn("private-token", json.dumps(container.metadata))
                    self.assertIn("seed", json.dumps(container.metadata))

    @staticmethod
    def _av_available():
        try:
            import av
            return True
        except ImportError:
            return False

    def test_four_toggle_combinations_use_verified_destination(self):
        for eagle, output in ((False, False), (True, False), (False, True), (True, True)):
            class Client:
                def __init__(self): self.calls = []
                def context(self): return {"library_key": "test", "folders": [{"id": "results", "ancestors": []}]}
                def export_paths(self, paths, names, *args):
                    self.calls.append((paths, names, args))
                    self.assert_paths = all(Path(path).is_file() for path in paths)
            client = Client()
            with patch.object(self.exports, "client_for", return_value=client):
                result = self.exports.EagleAudioExport().save(self.audio, settings=self.settings(save_eagle=eagle, save_output=output), tags="connected,tag", annotation="complete annotation")
            descriptor = result["ui"]["audio"][0]
            self.assertEqual(descriptor["type"], "output" if output else "temp")
            self.assertEqual(len(client.calls), int(eagle))
            if eagle:
                self.assertTrue(client.assert_paths)
                self.assertEqual(client.calls[0][2][-2:], (["connected", "tag"], "complete annotation"))

    def test_invalid_eagle_target_writes_no_persistent_output(self):
        before = set((Path(self.temp.name) / "output").rglob("*"))
        client = types.SimpleNamespace(context=lambda: {"library_key": "test", "folders": []})
        with patch.object(self.exports, "client_for", return_value=client), self.assertRaises(self.core.EagleError):
            self.exports.EagleVideoExport().save(frames=self.frames, settings=self.settings(save_eagle=True, save_output=True))
        self.assertEqual(before, set((Path(self.temp.name) / "output").rglob("*")))

    def test_real_frame_and_path_video_encoders(self):
        for format in ("mp4", "webm", "mkv"):
            result = self.exports.EagleVideoExport().save(frames=self.frames[:24], audio=self.audio, fps=24, format=format, settings=self.settings())
            saved = self.saved_path(result)
            frames = self.core.load_video(saved, {"video_max_seconds": 1})
            self.assertEqual(tuple(frames.shape), (24, 64, 80, 3))
            audio = self.core.load_audio(saved, {"audio_max_seconds": 1})
            self.assertGreater(audio["waveform"].abs().max(), .01)
            self.assertEqual(result["ui"]["animated"], (True,))
        remuxed = self.exports.EagleVideoExport().save(path=str(self.video_path), settings=self.settings())
        self.assertEqual(self.core.load_video(self.saved_path(remuxed), {"video_max_seconds": 2}).shape[0], 48)

    def test_native_video_object_receives_redacted_metadata(self):
        source = self.video_path
        class Video:
            def save_to(self, target, **kwargs):
                self.kwargs = kwargs
                Path(target).write_bytes(source.read_bytes())
        video = Video()
        result = self.exports.EagleVideoExport().save(video=video, settings=self.settings(), prompt={"token": "hidden", "seed": 3})
        self.assertTrue(self.saved_path(result).is_file())
        self.assertEqual(video.kwargs["metadata"]["prompt"], {"token": "", "seed": 3})

    def test_model_bundle_copies_only_resources_and_allows_safe_preview(self):
        (self.model_path.parent / "unrelated-private.txt").write_text("do not export", encoding="utf-8")
        result = self.exports.EagleModelExport().save(path=str(self.model_path), settings=self.settings(save_output=True), filename_prefix="3d/scene")
        saved = self.saved_path(result)
        self.assertEqual(saved.read_bytes(), self.model_path.read_bytes())
        self.assertTrue((saved.parent / "model.mtl").is_file())
        self.assertFalse((saved.parent / "unrelated-private.txt").exists())
        descriptor = result["ui"]["eagle_media"][0][0]
        model_id = descriptor["preview_url"].split("/")[-2]
        path, _ = self.runtime.model_resource(model_id, "model.mtl")
        self.assertEqual(path, saved.parent / "model.mtl")
        for resource in ("../unrelated-private.txt", "unrelated-private.txt", str(self.model_path)):
            with self.assertRaises(self.core.EagleError): self.runtime.model_resource(model_id, resource)

    def test_gltf_pack_preserves_animation_skin_and_texture(self):
        root = Path(self.temp.name) / "gltf_source"
        root.mkdir(exist_ok=True)
        (root / "vertices.bin").write_bytes(struct.pack("<9f", 0,0,0, 1,0,0, 0,1,0))
        Image.new("RGB", (2, 2), "red").save(root / "texture.png")
        data = {"asset": {"version": "2.0"}, "buffers": [{"uri": "vertices.bin", "byteLength": 36}],
                "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 36}], "images": [{"uri": "texture.png"}],
                "animations": [{"name": "preserve", "channels": [], "samplers": []}], "skins": [{"joints": [0]}],
                "nodes": [{}], "extensions": {"CUSTOM_extension": {"retain": True}}}
        source = root / "scene.gltf"
        source.write_text(json.dumps(data), encoding="utf-8")
        payload = self.exports._gltf_glb(source)
        self.assertEqual(payload[:4], b"glTF")
        length = struct.unpack_from("<I", payload, 12)[0]
        packed = json.loads(payload[20:20 + length])
        for key in ("animations", "skins", "nodes", "extensions"):
            self.assertEqual(packed[key], data[key])
        self.assertNotIn("uri", packed["buffers"][0]); self.assertNotIn("uri", packed["images"][0])
        self.assertEqual(packed["images"][0]["mimeType"], "image/png")

    def test_gltf_multibuffer_meshopt_offsets_remain_valid(self):
        root = Path(self.temp.name) / "meshopt_source"
        root.mkdir(exist_ok=True)
        (root / "a.bin").write_bytes(b"12345")
        (root / "b.bin").write_bytes(b"abcdefghi")
        data = {"asset": {"version": "2.0"}, "buffers": [{"uri": "a.bin", "byteLength": 5}, {"uri": "b.bin", "byteLength": 9}],
                "bufferViews": [{"buffer": 1, "byteOffset": 2, "byteLength": 3, "extensions": {
                    "EXT_meshopt_compression": {"buffer": 1, "byteOffset": 4, "byteLength": 3, "count": 1, "byteStride": 3, "mode": "ATTRIBUTES"},
                    "KHR_meshopt_compression": {"buffer": 0, "byteOffset": 1, "byteLength": 2, "count": 1, "byteStride": 2}}}]}
        source = root / "scene.gltf"
        source.write_text(json.dumps(data), encoding="utf-8")
        payload = self.exports._gltf_glb(source)
        length = struct.unpack_from("<I", payload, 12)[0]
        packed = json.loads(payload[20:20 + length])
        view = packed["bufferViews"][0]
        self.assertEqual((view["buffer"], view["byteOffset"]), (0, 10))
        self.assertEqual((view["extensions"]["EXT_meshopt_compression"]["buffer"], view["extensions"]["EXT_meshopt_compression"]["byteOffset"]), (0, 12))
        self.assertEqual(view["extensions"]["KHR_meshopt_compression"]["byteOffset"], 1)
        binary = payload[20 + length + 8:]
        self.assertEqual(binary[12:15], b"efg")

    def test_disk_file3d_path_source_preserves_companions(self):
        source = self.model_path
        class File3D:
            format = "obj"
            def get_source(self): return source
            def save_to(self, target): raise AssertionError("disk FILE_3D must retain sidecars from source")
        result = self.exports.EagleModelExport().save(model_3d=File3D(), settings=self.settings())
        saved = self.saved_path(result)
        self.assertTrue((saved.parent / "model.mtl").is_file())
        self.assertTrue(saved.name.startswith("ComfyUI_"))

    def test_official_type_validation_accepts_all_file3d_subtypes(self):
        source = Path(__file__).parents[2] / ".research-eagle" / "validation.py"
        io_source = source.parent / "io_types.py"
        if not source.is_file() or not io_source.is_file(): self.skipTest("official upstream type source not available")
        tree = ast.parse(source.read_text(encoding="utf-8-sig"))
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "validate_node_input")
        namespace = {"IO": types.SimpleNamespace(AnyType=types.SimpleNamespace(io_type="*"),
                     MatchType=types.SimpleNamespace(io_type="COMFY_MATCHTYPE_V3"), Combo=types.SimpleNamespace(io_type="COMBO"))}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[])), str(source), "exec"), namespace)
        validate = namespace["validate_node_input"]
        declared = self.exports.EagleModelExport.INPUT_TYPES()["optional"]["model_3d"][0]
        upstream = ast.parse(io_source.read_text(encoding="utf-8-sig"))
        names = []
        for node in upstream.body:
            if isinstance(node, ast.ClassDef):
                for decorator in node.decorator_list:
                    if isinstance(decorator, ast.Call):
                        for keyword in decorator.keywords:
                            if keyword.arg == "io_type" and isinstance(keyword.value, ast.Constant) and str(keyword.value.value).startswith("FILE_3D"):
                                names.append(keyword.value.value)
        self.assertGreaterEqual(len(names), 13)
        for name in names:
            self.assertTrue(validate(name, declared), name)
        self.assertFalse(validate("STRING", declared))
        self.assertFalse(validate("IMAGE", declared))

    def test_real_upstream_mesh_helper_exports_each_nonempty_batch(self):
        source = Path(__file__).parents[2] / ".research-eagle" / "nodes_save_3d.py"
        if not source.is_file(): self.skipTest("official upstream research source not available")
        tree = ast.parse(source.read_text(encoding="utf-8-sig"))
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in {"get_mesh_batch_item", "save_glb", "mesh_item_to_glb_bytes"}]
        module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), *functions], type_ignores=[])
        namespace = {"torch": torch, "np": np, "Image": Image, "json": json, "struct": struct, "BytesIO": io.BytesIO, "logging": logging, "math": math}
        exec(compile(ast.fix_missing_locations(module), str(source), "exec"), namespace)
        real = namespace["mesh_item_to_glb_bytes"]
        calls = []
        def helper(mesh, index, metadata):
            calls.append(index)
            return real(mesh, index, metadata)
        stub = types.ModuleType("comfy_extras.nodes_save_3d"); stub.mesh_item_to_glb_bytes = helper
        mesh = types.SimpleNamespace(vertices=torch.tensor([[[0.,0.,0.],[1.,0.,0.],[0.,1.,0.]], [[0.,0.,0.],[0.,0.,0.],[0.,0.,0.]]]),
            faces=torch.tensor([[[0,1,2]], [[0,0,0]]]), vertex_counts=torch.tensor([3,0]), face_counts=torch.tensor([1,0]),
            vertex_colors=None, uvs=torch.tensor([[[0.,0.],[1.,0.],[0.,1.]], [[0.,0.],[0.,0.],[0.,0.]]]), normals=None,
            texture=torch.ones((2,2,2,3))*.5, metallic_roughness=None, tangents=None, unlit=False, normal_map=None,
            occlusion_in_mr=False, material=None, emissive=None)
        with patch.dict(sys.modules, {"comfy_extras": types.ModuleType("comfy_extras"), "comfy_extras.nodes_save_3d": stub}):
            result = self.exports.EagleModelExport().save(mesh=mesh, settings=self.settings(), prompt={"token": "secret", "seed": 99})
        self.assertEqual(calls, [0, 1])
        self.assertEqual(len(result["ui"]["3d"]), 1)
        payload = self.saved_path(result).read_bytes()
        self.assertEqual(payload[:4], b"glTF")
        length = struct.unpack_from("<I", payload, 12)[0]
        data = json.loads(payload[20:20+length])
        self.assertIn("TEXCOORD_0", data["meshes"][0]["primitives"][0]["attributes"])
        self.assertEqual(data["asset"]["extras"]["prompt"]["token"], "")
        self.assertEqual(data["asset"]["extras"]["prompt"]["seed"], 99)
        self.assertEqual(data["images"][0]["mimeType"], "image/png")

    def test_obj_eagle_packages_glb_without_changing_local_format(self):
        if importlib.util.find_spec("trimesh") is None:
            self.skipTest("trimesh optional packaging dependency unavailable")
        class Client:
            def context(self): return {"library_key": "test", "folders": [{"id": "results", "ancestors": []}]}
            def export_paths(self, paths, *args): self.bytes = Path(paths[0]).read_bytes()
        client = Client()
        with patch.object(self.exports, "client_for", return_value=client):
            result = self.exports.EagleModelExport().save(path=str(self.model_path), settings=self.settings(save_eagle=True))
        self.assertEqual(client.bytes[:4], b"glTF")
        self.assertEqual(self.saved_path(result).suffix, ".obj")
        self.assertIn("GLB", result["ui"]["eagle_status"][0])

    def test_none_sources_and_conflicting_sources_are_explicit(self):
        for node, kwargs in ((self.exports.EagleAudioExport(), {"audio": None}), (self.exports.EagleVideoExport(), {}), (self.exports.EagleModelExport(), {})):
            self.assertEqual(node.save(settings=self.settings(save_eagle=True, folder_id=""), **kwargs)["ui"]["eagle_media"], [[]])
        with self.assertRaises(self.core.EagleError):
            self.exports.EagleVideoExport().save(frames=self.frames, path=str(self.video_path))
        with self.assertRaises(self.core.EagleError):
            self.exports.EagleModelExport().save(path=str(self.model_path), model_3d=object())
        with self.assertRaises(self.core.EagleError):
            self.exports.EagleAudioExport().save(self.audio, filename_prefix="../outside")


if __name__ == "__main__": unittest.main()
