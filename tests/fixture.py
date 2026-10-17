"""A ComfyUI API fixture + a local Eagle API fixture. Never writes to the user's Eagle."""
import asyncio
import base64
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
import mimetypes
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time
import types
from urllib.parse import parse_qs, urlsplit
import uuid
import wave

import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo

PLUGIN = Path(__file__).parents[1]


class NativeSaveFixture:
    kind = "output"
    def save_images(self, images, filename_prefix="ComfyUI", prompt=None, extra_pnginfo=None):
        import folder_paths
        root = Path(folder_paths.get_output_directory() if self.kind == "output" else folder_paths.get_temp_directory())
        descriptors = []
        for frame in images:
            name = "test_" + uuid.uuid4().hex + ".png"
            metadata = PngInfo()
            if prompt is not None:
                metadata.add_text("prompt", json.dumps(prompt))
            if extra_pnginfo is not None:
                for key, value in extra_pnginfo.items():
                    metadata.add_text(key, json.dumps(value))
            Image.fromarray(np.rint(frame.cpu().numpy().clip(0, 1) * 255).astype(np.uint8)).save(root / name, pnginfo=metadata)
            descriptors.append({"filename": name, "subfolder": "", "type": self.kind})
        return {"ui": {"images": descriptors}}


class NativePreviewFixture(NativeSaveFixture):
    kind = "temp"


def load_plugin(root, native_web=False):
    paths = types.ModuleType("folder_paths")
    directories = {}
    for name in ("temp", "output", "user", "input"):
        directory = Path(root) / name; directory.mkdir(parents=True, exist_ok=True)
        directories[name] = directory
        setattr(paths, f"get_{name}_directory", lambda directory=directory: str(directory))
    paths.base_path = str(Path(root).resolve())
    paths.get_directory_by_type = lambda kind: str(directories[kind]) if kind in directories else None
    path_counts = Counter()
    def get_save_image_path(filename_prefix, output_dir, image_width=0, image_height=0):
        prefix = str(filename_prefix or "ComfyUI").replace("\\", "/")
        folder = (Path(output_dir) / Path(prefix).parent).resolve()
        if not folder.is_relative_to(Path(output_dir).resolve()):
            raise ValueError("Fixture save path is outside output directory")
        folder.mkdir(parents=True, exist_ok=True)
        filename = Path(prefix).name or "ComfyUI"
        key = (str(folder), filename); path_counts[key] += 1
        return str(folder), filename, path_counts[key], folder.relative_to(Path(output_dir).resolve()).as_posix().replace(".", "", 1) if folder == Path(output_dir).resolve() else folder.relative_to(Path(output_dir).resolve()).as_posix(), prefix
    paths.get_save_image_path = get_save_image_path
    def get_annotated_filepath(filename, default_dir=None):
        match = re.fullmatch(r"(.*?)\s*\[(input|output|temp)\]", str(filename))
        name, base = (match[1], directories[match[2]]) if match else (str(filename), Path(default_dir or directories["input"]))
        return str((base / name).resolve())
    paths.get_annotated_filepath = get_annotated_filepath
    sys.modules["folder_paths"] = paths
    core_nodes = types.ModuleType("nodes")
    core_nodes.SaveImage = NativeSaveFixture; core_nodes.PreviewImage = NativePreviewFixture
    sys.modules["nodes"] = core_nodes
    handlers = {}
    class Routes:
        def post(self, url):
            def decorator(function): handlers[url] = function; return function
            return decorator
        def get(self, url):
            def decorator(function): handlers[url] = function; return function
            return decorator
    server = types.ModuleType("server")
    if native_web:
        from aiohttp import web
        registered_routes = web.RouteTableDef()
    else:
        registered_routes = Routes()
    server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=registered_routes))
    sys.modules["server"] = server
    if not native_web:
        aiohttp = types.ModuleType("aiohttp")
        aiohttp.web = types.SimpleNamespace(json_response=lambda value, status=200: (status, value),
            FileResponse=lambda path, **kwargs: (200, Path(path), kwargs.get("headers", {})))
        sys.modules["aiohttp"] = aiohttp
    name = "eagle_assets_fixture"
    for module_name in list(sys.modules):
        if module_name == name or module_name.startswith(name + "."):
            del sys.modules[module_name]
    spec = importlib.util.spec_from_file_location(name, PLUGIN / "__init__.py", submodule_search_locations=[str(PLUGIN)])
    module = importlib.util.module_from_spec(spec); sys.modules[name] = module; spec.loader.exec_module(module)
    return module, registered_routes if native_web else handlers


class Fixture:
    def __init__(self, root, media=False, native_web=False):
        self.root = Path(root).resolve(); self.root.mkdir(parents=True, exist_ok=True)
        self.plugin, self.handlers = load_plugin(root, native_web)
        self.native_web = native_web
        self.counts = Counter(); self.exports = []; self.ollama_calls = []
        self.library = self.root / "test.library"; self.library.mkdir(exist_ok=True)
        self.folders = [{"id": "assets", "name": "Assets", "children": [{"id": "actors", "name": "Actors", "children": []}]}, {"id": "results", "name": "Results", "children": []}]
        self.items = []
        for index, name in enumerate(["1", "2", "3", "4", "10"]):
            self.add_item("asset" + str(index), name, "assets" if index != 3 else "actors", (64 + index * 16, 64 + index * 8), (60 + index * 25, 100, 160))
        if media:
            self.add_media_items()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), self.handler())
        self.host = "http://127.0.0.1:" + str(self.httpd.server_address[1])
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True); self.thread.start()

    def add_item(self, item_id, name, folder, size, color):
        directory = self.library / "images" / (item_id + ".info"); directory.mkdir(parents=True, exist_ok=True)
        image_path = directory / (name + ".png"); Image.new("RGB", size, color).save(image_path)
        item = {"id": item_id, "name": name, "ext": "png", "width": size[0], "height": size[1], "size": image_path.stat().st_size,
                "folders": [folder], "tags": ["test"], "btime": len(self.items) + 1, "modificationTime": 10 - len(self.items), "isDeleted": False}
        self.items.append(item); return item

    def add_file_item(self, item_id, name, ext, folders, content=None):
        directory = self.library / "images" / (item_id + ".info"); directory.mkdir(parents=True, exist_ok=True)
        path = directory / (name + "." + ext)
        if content is not None:
            path.write_bytes(content)
        item = {"id": item_id, "name": name, "ext": ext, "size": path.stat().st_size if path.exists() else 0,
                "folders": folders, "tags": ["test", ext], "btime": len(self.items) + 1, "modificationTime": 100 - len(self.items), "isDeleted": False}
        self.items.append(item)
        return item, path

    def add_media_items(self):
        """Small local assets only, separate folders keep the original image fixtures stable."""
        self.folders.extend([{"id": "media_mix", "name": "Mixed media", "children": []},
                             {"id": "media_extra", "name": "Extra media", "children": []}])
        image = self.add_item("media_image", "picture", "media_mix", (80, 64), (90, 130, 170))
        image["folders"].append("media_extra")
        audio, audio_path = self.add_file_item("media_audio", "sound", "wav", ["media_mix"])
        with wave.open(str(audio_path), "wb") as output:
            output.setnchannels(1); output.setsampwidth(2); output.setframerate(24000)
            samples = (np.sin(np.arange(48000) * 2 * np.pi * 440 / 24000) * 6000).astype("<i2")
            output.writeframes(samples.tobytes())
        audio.update(size=audio_path.stat().st_size, duration=2)
        video, video_path = self.add_file_item("media_video", "clip", "mp4", ["media_mix", "media_extra"])
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg:
            subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=steelblue:s=80x64:r=24:d=2",
                            "-c:v", "libx264", "-pix_fmt", "yuv420p", str(video_path)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            video.update(size=video_path.stat().st_size, width=80, height=64, duration=2)
        else:
            # Catalog tests still run without a decoder; execution tests explicitly require ffmpeg.
            video_path.write_bytes(b"fixture-video-needs-ffmpeg")
            video.update(size=video_path.stat().st_size)
        obj = b"mtllib model.mtl\no fixture_triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl material\nf 1 2 3\n"
        _, model_path = self.add_file_item("media_model", "model", "obj", ["media_mix"], obj)
        (model_path.parent / "model.mtl").write_text("newmtl material\nKd 0.4 0.7 0.9\n", encoding="utf-8")
        self.add_file_item("media_model2", "model2", "obj", ["media_extra"], b"o second\nv 0 0 0\nv 2 0 0\nv 0 2 0\nf 1 2 3\n")
        audio2, audio2_path = self.add_file_item("media_audio2", "sound2", "wav", ["media_extra"], audio_path.read_bytes())
        audio2.update(size=audio2_path.stat().st_size, duration=2)
        video2, video2_path = self.add_file_item("media_video2", "clip2", "mp4", ["media_extra"], video_path.read_bytes())
        video2.update(size=video2_path.stat().st_size, width=80, height=64, duration=2)

    def model_variant(self, format):
        """Real local geometry, including separately served glTF buffers and texture."""
        if format not in {"glb", "gltf", "stl"}: raise ValueError("invalid model fixture format")
        directory = self.root / "model_variants" / format; directory.mkdir(parents=True, exist_ok=True)
        path = directory / ("box." + format)
        if path.exists(): return path
        import trimesh
        mesh = trimesh.creation.box(extents=[1, 0.8, 0.6])
        mesh.visual = trimesh.visual.texture.TextureVisuals(uv=mesh.vertices[:, :2] + 0.5,
                                                           image=Image.new("RGB", (16, 16), (200, 80, 60)))
        if format == "stl":
            path.write_bytes(mesh.export(file_type="stl")); return path
        if format == "glb":
            path.write_bytes(trimesh.Scene(mesh).export(file_type="glb")); return path
        files = trimesh.Scene(mesh).export(file_type="gltf")
        document = json.loads(files.pop("model.gltf"))
        image_entry = document["images"][0]; view = document["bufferViews"][image_entry["bufferView"]]
        buffer = document["buffers"][view["buffer"]]
        offset = view.get("byteOffset", 0)
        texture = files[buffer["uri"]][offset:offset + view["byteLength"]]
        document["images"][0] = {"uri": "texture.png"}
        for name, payload in files.items(): (directory / name).write_bytes(payload)
        (directory / "texture.png").write_bytes(texture)
        path.write_text(json.dumps(document), encoding="utf-8")
        return path

    def handler(self):
        fixture = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def send_json(self, value, status=200):
                data = json.dumps(value, ensure_ascii=False).encode("utf-8"); self.send_response(status); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
            def do_GET(self):
                parsed = urlsplit(self.path); query = parse_qs(parsed.query); path = parsed.path
                if path == "/api/tags":
                    fixture.counts["ollama/tags"] += 1
                    return self.send_json({"models": [{"name": "mock-vision:latest", "size": 123456789, "details": {"family": "qwen35", "parameter_size": "9B"}},
                                                       {"name": "mock-text:latest", "size": 34567890, "details": {"family": "llama", "parameter_size": "3B"}},
                                                       {"name": "mock-vision:cloud", "size": 0, "details": {"family": "qwen35"}, "remote_model": "mock-vision:cloud", "remote_host": "https://ollama.com"}]})
                if path.startswith("/api/"):
                    endpoint = path[5:]; fixture.counts[endpoint] += 1
                    if endpoint == "library/info": data = {"library": {"path": str(fixture.library), "name": "Fixture"}}
                    elif endpoint == "folder/list": data = fixture.folders
                    elif endpoint == "item/list":
                        folders = set(query.get("folders", [""])[0].split(",")) - {""}
                        items = [item for item in fixture.items if not folders or set(item["folders"]) & folders]
                        items.sort(key=lambda item: item["name"])
                        offset, limit = int(query.get("offset", [0])[0]), int(query.get("limit", [200])[0]); data = items[offset:offset + limit]
                    elif endpoint == "item/thumbnail":
                        item = next((item for item in fixture.items if item["id"] == query.get("id", [None])[0]), None)
                        if not item: return self.send_json({"status": "error"}, 404)
                        data = str(fixture.library / "images" / (item["id"] + ".info") / (item["name"] + "." + item["ext"]))
                    elif endpoint == "item/info":
                        data = next((dict(item) for item in fixture.items if item["id"] == query.get("id", [None])[0]), None)
                        if data is None: return self.send_json({"status": "error"}, 404)
                    else: return self.send_json({"status": "error"}, 404)
                    return self.send_json({"status": "success", "data": data})
                if path == "/tests/stats": return self.send_json({"counts": dict(fixture.counts), "exports": len(fixture.exports),
                                                                 "output_files": len(list((fixture.root / "output").rglob("*.*"))),
                                                                 "temp_files": len(list((fixture.root / "temp").rglob("*.*")))})
                for route, handler in ([] if fixture.native_web else fixture.handlers.items()):
                    if "{" not in route: continue
                    pattern = re.sub(r"\{(\w+)(?::([^}]+))?\}", lambda matched: "(?P<" + matched[1] + ">" + (matched[2] or "[^/]+") + ")", route)
                    match = re.fullmatch(pattern, path)
                    if match:
                        request = types.SimpleNamespace(match_info=match.groupdict(), headers=dict(self.headers), query={key: values[0] for key, values in query.items()})
                        response = asyncio.run(handler(request))
                        if len(response) == 2: return self.send_json(response[1], response[0])
                        status, target, headers = response
                        content = target.read_bytes(); self.send_response(status)
                        for key, value in headers.items(): self.send_header(key, value)
                        if not any(key.lower() == "content-type" for key in headers):
                            self.send_header("Content-Type", mimetypes.guess_type(str(target))[0] or "application/octet-stream")
                        self.send_header("Content-Length", str(len(content))); self.end_headers(); self.wfile.write(content); return
                if path == "/scripts/app.js":
                    content = "export const app={registerExtension(e){this.extension=e},graph:{links:{1:{origin_id:1}},change(){},getNodeById(id){return globalThis.testNodes?.[id]}}};".encode(); mime = "text/javascript"
                elif path == "/scripts/api.js":
                    content = "export const api={apiURL:path=>path,fetchApi:(path,options)=>fetch(path,options)};".encode(); mime = "text/javascript"
                elif path == "/view":
                    from folder_paths import get_temp_directory, get_output_directory
                    root = Path(get_output_directory() if query.get("type", ["temp"])[0] == "output" else get_temp_directory())
                    target = (root / query.get("subfolder", [""])[0] / query["filename"][0]).resolve()
                    if not target.is_relative_to(root) or not target.is_file(): return self.send_json({}, 404)
                    content = target.read_bytes(); mime = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
                else:
                    target = (PLUGIN / ("." + path)).resolve()
                    if not target.is_relative_to(PLUGIN) or not target.is_file(): return self.send_json({}, 404)
                    content = target.read_bytes(); mime = "text/html" if path.endswith(".html") else "text/javascript"
                self.send_response(200); self.send_header("Content-Type", mime); self.send_header("Cache-Control", "no-store"); self.send_header("Content-Length", str(len(content))); self.end_headers(); self.wfile.write(content)
            def do_POST(self):
                path = urlsplit(self.path).path; body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                if path == "/api/show":
                    fixture.counts["ollama/show"] += 1
                    vision = "vision" in str(body.get("model", ""))
                    return self.send_json({"capabilities": ["completion", *( ["vision"] if vision else [])],
                                           "details": {"family": "qwen35" if vision else "llama"}, "model_info": {"general.architecture": "qwen35" if vision else "llama"}})
                if path == "/api/chat":
                    fixture.counts["ollama/chat"] += 1; fixture.ollama_calls.append(body)
                    self.send_response(200); self.send_header("Content-Type", "application/x-ndjson"); self.end_headers()
                    text = "".join(str(message.get("content", "")) for message in body.get("messages", []))
                    chunks = ["第一段：", "镜头从窗外进入，", "角色停下脚步。", "\n第二段：", "音乐渐弱，", "画面切到远景。"]
                    if "[repeat]" in text: chunks = ["有效内容：镜头从窗外进入。\n"] + ["in the image, "] * 100
                    if "[slow]" in text: chunks = ["逐字输出" + str(index) + " " for index in range(100)]
                    try:
                        for index, chunk in enumerate(chunks):
                            event = {"model": body.get("model"), "message": {"role": "assistant", "content": chunk, **({"thinking": "整理参考素材"} if index == 0 else {})}, "done": False}
                            self.wfile.write((json.dumps(event, ensure_ascii=False) + "\n").encode()); self.wfile.flush(); time.sleep(0.06 if "[slow]" in text else 0.02)
                        self.wfile.write((json.dumps({"model": body.get("model"), "message": {"role": "assistant", "content": ""}, "done": True,
                                                     "total_duration": 1000000000, "prompt_eval_count": 20, "eval_count": len(chunks)}, ensure_ascii=False) + "\n").encode()); self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                        pass
                    return
                if path == "/api/item/update":
                    item = next((item for item in fixture.items if item["id"] == body.get("id")), None)
                    if item is None: return self.send_json({"status": "error"}, 404)
                    if "name" in body:
                        directory = fixture.library / "images" / (item["id"] + ".info")
                        (directory / (item["name"] + "." + item["ext"])).rename(directory / (body["name"] + "." + item["ext"]))
                        item["name"] = body["name"]
                    item.update({key: body[key] for key in ("annotation", "tags") if key in body})
                    return self.send_json({"status": "success", "data": item})
                if path == "/api/item/addFromPaths":
                    fixture.counts["item/addFromPaths"] += 1; fixture.exports.append(body)
                    for index, item in enumerate(body["items"]):
                        source = Path(item["path"]); assert source.is_file()
                        ext = source.suffix.lower().lstrip(".")
                        added, target = fixture.add_file_item("export" + uuid.uuid4().hex, item["name"], ext, [body.get("folderId", "")])
                        shutil.copyfile(source, target); added["size"] = target.stat().st_size
                        if ext in {"png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "gif", "avif"}:
                            with Image.open(source) as image: added.update(width=image.width, height=image.height)
                        elif ext in {"obj", "gltf"}:
                            for resource in source.parent.rglob("*"):
                                if resource.is_file() and resource != source:
                                    relative = resource.relative_to(source.parent); destination = target.parent / relative
                                    destination.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(resource, destination)
                        added.update(tags=item.get("tags", []), annotation=item.get("annotation", ""))
                    return self.send_json({"status": "success"})
                if not fixture.native_web and path in fixture.handlers:
                    class FakeRequest:
                        async def json(self): return body
                    status, value = asyncio.run(fixture.handlers[path](FakeRequest())); return self.send_json(value, status)
                if path == "/tests/run-import":
                    result = fixture.plugin.NODE_CLASS_MAPPINGS["EagleAssetImport"]().load(body["settings"], body.get("query"))
                    return self.send_json({"ui": result["ui"], "ids": [asset.metadata["id"] for asset in result["result"][0].items]})
                if path == "/tests/run-media-import":
                    result = fixture.plugin.NODE_CLASS_MAPPINGS["EagleMediaImport"]().load(body["settings"], body.get("query"))
                    return self.send_json({"ui": result["ui"], "ids": [[asset.metadata["id"] for asset in bundle.items] for bundle in result["result"][:4]]})
                if path == "/tests/run-export":
                    import torch
                    result = fixture.plugin.NODE_CLASS_MAPPINGS["EagleAssetExport"]().save(torch.zeros((1, 64, 64, 3)), settings=body["settings"],
                                                                                        tags=body.get("tags"), annotation=body.get("annotation"))
                    return self.send_json({"ui": result["ui"], "payload": fixture.exports[-1] if fixture.exports else None})
                if path == "/tests/run-media-export":
                    from eagle_assets_fixture.core import load_audio, load_video
                    kind = body["kind"]
                    inputs = {"settings": body["settings"], "filename_prefix": body.get("filename_prefix", "EagleMediaFixture"),
                              "tags": body.get("tags"), "annotation": body.get("annotation")}
                    if kind == "audio":
                        inputs.update(audio=load_audio(fixture.library / "images" / "media_audio.info" / "sound.wav"), format=body.get("format", "wav"))
                    elif kind == "video":
                        video_path = fixture.library / "images" / "media_video.info" / "clip.mp4"
                        inputs.update(fps=body.get("fps", 24), format=body.get("format", "mp4"))
                        if body.get("source", "frames") == "path": inputs["path"] = str(video_path)
                        else: inputs["frames"] = load_video(video_path, {"video_fps": 24, "video_max_seconds": 2})
                    elif kind == "model":
                        inputs["path"] = str(fixture.model_variant(body["model_format"]) if body.get("model_format") else fixture.library / "images" / "media_model.info" / "model.obj")
                    else: return self.send_json({"error": "invalid media kind"}, 400)
                    before = len(fixture.exports)
                    cls_name = {"audio": "EagleAudioExport", "video": "EagleVideoExport", "model": "EagleModelExport"}[kind]
                    result = fixture.plugin.NODE_CLASS_MAPPINGS[cls_name]().save(**inputs)
                    return self.send_json({"ui": result["ui"], "payload": fixture.exports[-1] if len(fixture.exports) > before else None,
                                           "exports": len(fixture.exports), "output_files": len(list((fixture.root / "output").rglob("*.*"))),
                                           "temp_files": len(list((fixture.root / "temp").rglob("*.*")))})
                if path == "/tests/inspect-preview":
                    with Image.open(io.BytesIO(base64.b64decode(body["image_base64"]))) as preview:
                        pixels = np.asarray(preview.convert("RGB"), dtype=np.int16)
                    background = pixels[0, 0]
                    visible = np.max(np.abs(pixels - background), axis=-1) > 25
                    return self.send_json({"visible_pixels": int(visible.sum()), "pixels": int(visible.size)})
                if path == "/tests/add-media":
                    fixture.add_item("media_added", "newpicture", "media_mix", (72, 64), (150, 70, 40)); return self.send_json({"ok": True})
                if path == "/tests/add":
                    fixture.add_item("added", "new", "assets", (80, 80), (150, 70, 40)); return self.send_json({"ok": True})
                return self.send_json({}, 404)
        return Handler

    def settings(self, **overrides):
        return {"version": 1, "host": self.host, "token": "", "folder_id": "assets", "limit": 20, "include_children": True,
                "manual_query": "1/2", "selection_mode": "query", "selected_ids": [], "locked": None, "match_mode": "exact", **overrides}

    def close(self):
        self.httpd.shutdown(); self.httpd.server_close(); self.thread.join(timeout=2)
