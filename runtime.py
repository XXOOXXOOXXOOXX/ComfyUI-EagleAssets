from collections import OrderedDict
from pathlib import Path
from threading import RLock
import time
import uuid
import io
import mimetypes
import numpy as np

from PIL import Image, ImageOps

from .core import (EagleClient, EagleError, SnapshotStore, public_item, select_items,
                   configured_folders, configured_types, media_type, _run_ffmpeg)

_catalogs = OrderedDict()
_media_files = OrderedDict()
_model_files = OrderedDict()
_mutex = RLock()
CATALOG_TTL = 1800


def snapshot_store():
    import folder_paths
    return SnapshotStore(Path(folder_paths.get_user_directory()) / "eagle_assets" / "snapshots")


def client_for(settings):
    return EagleClient(settings.get("host", "http://localhost:41595"), settings.get("token", ""))


def catalog_for(settings):
    return client_for(settings).catalog(configured_folders(settings), settings.get("limit", 20),
        bool(settings.get("include_children", False)), settings.get("library_key"), configured_types(settings))


def media_file(media_id):
    with _mutex:
        entry = _media_files.get(media_id)
    if not entry or time.monotonic() - entry["time"] > CATALOG_TTL:
        raise EagleError("媒体预览已过期，请刷新预览。")
    path = entry["path"]
    # No request-provided paths; recheck that the registered file has not become a symlink.
    if not path.is_file() or path.resolve() != path or not path.resolve().is_relative_to(entry["root"]):
        raise EagleError("媒体原始文件已变化，请刷新预览。")
    return path, entry["mime"]


def _media_url(path, kind):
    if kind not in {"audio", "video", "model"}:
        return None
    media_id = uuid.uuid4().hex
    path = Path(path).resolve()
    mime = mimetypes.guess_type(path.name)[0] or {"video": "video/mp4", "audio": "audio/wav", "model": "application/octet-stream"}[kind]
    with _mutex:
        _media_files[media_id] = {"path": path, "root": path.parent.resolve(), "mime": mime, "time": time.monotonic()}
        while len(_media_files) > 4096:
            _media_files.popitem(last=False)
    return "/eagle_assets/media/" + media_id


def model_preview_url(path):
    from urllib.parse import quote
    path = Path(path).resolve()
    root = path.parent
    resources = {}
    for child in root.rglob("*"):
        resolved = child.resolve()
        if child.is_file() and not child.is_symlink() and resolved.is_relative_to(root):
            resources[child.relative_to(root).as_posix()] = resolved
    model_id = uuid.uuid4().hex
    with _mutex:
        _model_files[model_id] = {"time": time.monotonic(), "root": root, "resources": resources}
        while len(_model_files) > 512:
            _model_files.popitem(last=False)
    return f"/eagle_assets/model/{model_id}/" + quote(path.name)


def model_resource(model_id, resource):
    with _mutex:
        entry = _model_files.get(model_id)
    if not entry or time.monotonic() - entry["time"] > CATALOG_TTL:
        raise EagleError("模型预览已过期。")
    # Only exact files registered from the private exported model bundle are served.
    resource = str(resource).replace("\\", "/")
    path = entry["resources"].get(resource)
    if path is None or not path.is_file() or path.resolve() != path or not path.resolve().is_relative_to(entry["root"]):
        raise EagleError("模型预览资源不存在。")
    mime = {".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".obj": "text/plain", ".mtl": "text/plain"}.get(path.suffix.lower())
    return path, mime or mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def _thumbnail(path, kind):
    path = Path(path)
    if kind == "image":
        with Image.open(path) as source:
            return ImageOps.exif_transpose(source).convert("RGB")
    candidates = sorted(file for file in path.parent.iterdir() if file.is_file() and "thumbnail" in file.stem.lower()
                        and file.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"} and file.resolve().is_relative_to(path.parent.resolve()))
    for candidate in candidates:
        try:
            with Image.open(candidate) as source:
                return source.convert("RGB")
        except (OSError, ValueError):
            continue
    if kind == "video":
        try:
            import av
            with av.open(str(path)) as container:
                frame = next(container.decode(video=0))
                pixels = frame.to_ndarray(format="rgb24")
                rotation = int(round(getattr(frame, "rotation", 0) // 90)) % 4
                if rotation:
                    pixels = np.rot90(pixels, k=rotation, axes=(0, 1)).copy()
                return Image.fromarray(pixels)
        except ImportError:
            try:
                output = _run_ffmpeg(["-i", str(path), "-frames:v", "1", "-vf", "scale=240:180:force_original_aspect_ratio=decrease",
                                      "-threads", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"])
                with Image.open(io.BytesIO(output)) as source:
                    return source.convert("RGB")
            except (EagleError, OSError, ValueError):
                pass
        except Exception:
            pass
    return None


def preview_item(item, path=None, image=None):
    import folder_paths
    path = path or item.get("_path")
    temp = Path(folder_paths.get_temp_directory())
    temp.mkdir(parents=True, exist_ok=True)
    filename = "eagle_asset_preview_" + uuid.uuid4().hex + ".jpg"
    result = public_item(item)
    kind = media_type(item)
    image = image or (_thumbnail(path, kind) if path else None)
    result["preview"] = None
    if image is not None:
        width, height = image.size
        if kind == "image":
            result.update(width=width, height=height)
        image.thumbnail((240, 180))
        image.save(temp / filename, quality=85)
        result["preview"] = {"filename": filename, "subfolder": "", "type": "temp"}
    url = _media_url(path, kind) if path else None
    if url:
        result["media_url"] = url
    return result


def prepare_catalog(settings):
    ctx, items = catalog_for(settings)
    return publish_catalog(settings, ctx, items)


def publish_catalog(settings, ctx, items):
    previews = [preview_item(item) for item in items]
    catalog_id = uuid.uuid4().hex
    with _mutex:
        _catalogs[catalog_id] = {"time": time.monotonic(), "items": items, "settings": dict(settings), "library_key": ctx["library_key"]}
        while len(_catalogs) > 64:
            _catalogs.popitem(last=False)
    return {"catalog_id": catalog_id, "items": previews, "library_key": ctx["library_key"], "library_name": ctx["library_name"]}


def lock_catalog(catalog_id, settings, selected_ids):
    with _mutex:
        entry = _catalogs.get(catalog_id)
    if not entry or time.monotonic() - entry["time"] > CATALOG_TTL:
        raise EagleError("预览会话已过期，请刷新图片后再锁定。")
    old = entry["settings"]
    for key in ("host", "token", "folder_id", "folder_count", "folder_ids", "types", "limit", "include_children", "library_key",
                "video_fps", "video_start_seconds", "video_max_seconds", "video_max_edge", "audio_start_seconds", "audio_max_seconds"):
        if old.get(key) != settings.get(key):
            raise EagleError("目录或加载设置已变化，请先重新加载预览。")
    ctx = client_for(settings).context()
    if ctx["library_key"] != entry["library_key"]:
        raise EagleError("Eagle 素材库已变化，请刷新预览后再锁定。")
    items = select_items(entry["items"], selected_ids=selected_ids, mode="manual")
    return snapshot_store().create(items, settings)


def snapshot_previews(sid):
    items, _ = snapshot_store().items(sid)
    return [preview_item(item) for item in items]
