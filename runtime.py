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
    if kind not in {"image", "audio", "video", "model"}:
        return None
    media_id = uuid.uuid4().hex
    path = Path(path).resolve()
    mime = mimetypes.guess_type(path.name)[0] or {"image": "image/png", "video": "video/mp4", "audio": "audio/wav", "model": "application/octet-stream"}[kind]
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
    if kind == "model" and path:
        result["model_url"] = model_preview_url(path)
    return result


def inspect_eagle_item(settings, item_id, name=None):
    from .core import original_path
    import re
    if not isinstance(item_id, str) or not re.fullmatch(r"[\w-]+", item_id):
        raise EagleError("Eagle 素材 ID 无效。")
    client = client_for(settings)
    ctx = client.context()
    if settings.get("library_key") and ctx["library_key"] != settings["library_key"]:
        raise EagleError("Eagle 素材库已切换，请刷新预览后重试。")
    item = client.request("item/info", {"id": item_id})
    if not isinstance(item, dict) or item.get("id") != item_id or item.get("isDeleted"):
        raise EagleError("Eagle 中已找不到此素材，请刷新预览。")
    old_path = original_path(ctx["root"], item)
    if name is not None:
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 240 or re.search(r'[<>:"/\\|?*\x00-\x1f]', name):
            raise EagleError("素材名称不能为空，且不能包含路径或文件名禁用字符。")
        name = name.strip()
        try:
            client.request("item/update", payload={"id": item_id, "name": name})
        except EagleError:
            pass
        item = client.request("item/info", {"id": item_id})
        if item.get("name") != name:
            _rename_with_companion(ctx["root"], item_id, name)
            item = client.request("item/info", {"id": item_id})
            if item.get("name") != name:
                raise EagleError("Eagle 尚未返回新名称，请刷新后确认。")
        new_path = original_path(ctx["root"], item)
        with _mutex:
            for record in _media_files.values():
                if record["path"] == old_path: record["path"] = new_path
            for record in _model_files.values():
                for key, path in record["resources"].items():
                    if path == old_path: record["resources"][key] = new_path
            for entry in _catalogs.values():
                if entry["library_key"] != ctx["library_key"]: continue
                for original in entry["items"]:
                    if original["id"] == item_id: original.update(item, _path=str(new_path))
                for preview in entry["previews"]:
                    if preview["id"] == item_id: preview.update(name=item["name"], annotation=item.get("annotation", ""))
    return {"item": {**public_item(item), "library_key": ctx["library_key"]}}


def _rename_with_companion(library_root, item_id, name):
    import os, sys, json
    from urllib.request import Request, build_opener, ProxyHandler
    if os.name == "nt": base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin": base = Path.home() / "Library" / "Application Support"
    else: base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    try:
        connection = json.loads((base / "EagleAssetsBridge" / "connection.json").read_text(encoding="utf-8"))
        port, token = connection["port"], connection["token"]
        if type(port) is not int or not 1024 <= port <= 65535 or not isinstance(token, str) or len(token) != 64:
            raise ValueError()
        payload = json.dumps({"id": item_id, "name": name, "library_path": str(library_root)}).encode()
        request = Request(f"http://127.0.0.1:{port}/rename", data=payload, headers={"Content-Type": "application/json", "X-Eagle-Assets-Token": token})
        with build_opener(ProxyHandler({})).open(request, timeout=15) as response:
            if not json.load(response).get("ok"): raise ValueError()
    except (OSError, ValueError, KeyError, TypeError):
        raise EagleError("此 Eagle 版本需先安装并运行更新包内 eagle-companion/EagleAssetsBridge 改名服务，再点保存。") from None


def resolve_export_item(settings, name, ext, excluded_ids):
    if not isinstance(name, str) or not name or not isinstance(excluded_ids, list) or len(excluded_ids) > 200:
        raise EagleError("本次导出缺少可验证的 Eagle 关联信息，请在导入节点中刷新后查看。")
    client = client_for(settings)
    ctx = client.context()
    if settings.get("library_key") and settings["library_key"] != ctx["library_key"]:
        raise EagleError("Eagle 素材库已切换，请返回导入节点刷新预览。")
    candidates = client.request("item/list", {"keyword": name, "limit": 200, "orderBy": "-CREATEDATE"}) or []
    folder = settings.get("folder_id")
    items = [item for item in candidates if item.get("name") == name and item.get("ext", "").lower() == ext
             and item.get("id") not in excluded_ids and not item.get("isDeleted") and (folder == "__ALL__" or folder in item.get("folders", []))]
    if len(items) != 1:
        raise EagleError("尚未唯一找到本次导入的 Eagle 素材。请等待 Eagle 完成导入后重新打开；也可从导入节点刷新后查看。")
    return inspect_eagle_item(settings, items[0]["id"])


def prepare_catalog(settings):
    ctx, items = catalog_for(settings)
    return publish_catalog(settings, ctx, items)


def publish_catalog(settings, ctx, items):
    previews = [preview_item(item) for item in items]
    catalog_id = uuid.uuid4().hex
    with _mutex:
        _catalogs[catalog_id] = {"time": time.monotonic(), "items": items, "previews": previews, "settings": dict(settings), "library_key": ctx["library_key"]}
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


def studio_catalog(catalog_id=None, snapshot_id=None):
    """A lightweight descriptor for the loaded gallery, independent from tensor outputs."""
    if bool(catalog_id) == bool(snapshot_id):
        raise EagleError("素材目录引用无效。")
    if snapshot_id:
        return {"snapshot_id": snapshot_id, "items": snapshot_previews(snapshot_id)}
    with _mutex:
        entry = _catalogs.get(catalog_id)
    if not entry or time.monotonic() - entry["time"] > CATALOG_TTL:
        raise EagleError("素材目录会话已过期，请刷新 Eagle 导入预览。")
    return {"catalog_id": catalog_id, "library_key": entry["library_key"], "items": [dict(item) for item in entry["previews"]]}


def resolve_studio_media(refs):
    """Resolve only opaque catalog/snapshot references; caller paths are never accepted."""
    if not isinstance(refs, list) or len(refs) > 32:
        raise EagleError("一次最多引用 32 个 Eagle 素材。")
    results, seen = [], set()
    for ref in refs:
        if not isinstance(ref, dict) or set(ref) - {"catalog_id", "snapshot_id", "item_id"}:
            raise EagleError("Eagle 素材引用格式无效。")
        cid, sid, item_id = ref.get("catalog_id"), ref.get("snapshot_id"), ref.get("item_id")
        if bool(cid) == bool(sid) or not isinstance(item_id, str):
            raise EagleError("Eagle 素材引用格式无效。")
        key = (cid or sid, item_id)
        if key in seen:
            continue
        if sid:
            items, _ = snapshot_store().items(sid)
        else:
            with _mutex:
                entry = _catalogs.get(cid)
            if not entry or time.monotonic() - entry["time"] > CATALOG_TTL:
                raise EagleError("Eagle 预览会话已过期，请刷新导入预览。")
            items = entry["items"]
        item = next((item for item in items if item["id"] == item_id), None)
        if item is None:
            raise EagleError("所选 Eagle 素材不在已登记的目录中。")
        path = Path(item["_path"])
        if not path.is_file() or path.resolve() != path:
            raise EagleError("Eagle 素材文件已变化，请刷新预览。")
        results.append({"path": str(path), "metadata": public_item(item), "ref": dict(ref)})
        seen.add(key)
    return results
