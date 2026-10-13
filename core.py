"""Eagle API, heterogeneous image assets, persistent local output snapshots."""
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
import hashlib
import json
import re
import unicodedata
import uuid
import math
import shutil
import subprocess
import tempfile

import numpy as np
from PIL import Image, ImageOps
import torch

MEDIA_EXTENSIONS = {
    "image": {"png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "gif", "avif"},
    "video": {"mp4", "mov", "mkv", "webm", "avi", "m4v", "mpg", "mpeg", "wmv", "ts"},
    "audio": {"wav", "mp3", "flac", "m4a", "aac", "ogg", "opus", "aiff", "aif", "wma"},
    "model": {"obj", "glb", "gltf", "fbx", "stl", "ply", "usdz", "spz", "splat", "ksplat"},
}
SUPPORTED = MEDIA_EXTENSIONS["image"]
ALL_SUPPORTED = set().union(*MEDIA_EXTENSIONS.values())
MAX_LIMIT = 500
MAX_OUTPUTS = 64
MAX_FOLDERS = 32
MAX_VIDEO_PIXELS = 120_000_000


def media_type(item):
    ext = str(item.get("ext", "")).lower().lstrip(".")
    return next((kind for kind, extensions in MEDIA_EXTENSIONS.items() if ext in extensions), None)


def configured_types(settings):
    kinds = settings.get("types", ["image"])
    if not isinstance(kinds, list) or any(kind not in MEDIA_EXTENSIONS for kind in kinds):
        raise EagleError("加载类型无效，请选择图片、视频、音频或模型。")
    kinds = list(dict.fromkeys(kinds))
    if not kinds:
        raise EagleError("请至少开启一种加载类型。")
    return kinds


def configured_folders(settings):
    values = settings.get("folder_ids")
    if values is None:
        values = [settings.get("folder_id", "")]
    count = settings.get("folder_count", len(values) if isinstance(values, list) else 1)
    if type(count) is not int or not 1 <= count <= MAX_FOLDERS:
        raise EagleError(f"目录数量必须为 1–{MAX_FOLDERS} 的整数。")
    if not isinstance(values, list) or len(values) < count or any(not isinstance(value, str) or not value for value in values[:count]):
        raise EagleError("请为每个目录选择框选择 Eagle 目录，再加载资产。")
    return list(dict.fromkeys(values[:count]))


class EagleError(ValueError):
    pass


def parse_settings(raw):
    try:
        data = json.loads(raw)
    except (ValueError, TypeError) as exc:
        raise EagleError("节点设置损坏，请重建节点或恢复工作流。") from exc
    if not isinstance(data, dict) or data.get("version") != 1:
        raise EagleError("不支持的节点设置版本。")
    return data


def check_limit(limit):
    if type(limit) is not int or not 1 <= limit <= MAX_LIMIT:
        raise EagleError(f"加载上限必须是 1–{MAX_LIMIT} 的整数。")
    return limit


class EagleClient:
    def __init__(self, host="http://localhost:41595", token="", timeout=15):
        url = urlsplit(str(host).strip())
        if url.scheme not in {"http", "https"} or not url.hostname or url.query or url.fragment or url.username or url.password:
            raise EagleError("Eagle 地址必须为 http://主机:端口 或 https://主机:端口。")
        if url.path not in {"", "/"}:
            raise EagleError("请填写 Eagle 服务根地址，不要添加 /api。")
        self.host, self.token, self.timeout = str(host).strip().rstrip("/"), str(token or ""), timeout

    def request(self, endpoint, params=None, payload=None):
        params = dict(params or {})
        headers = {"Accept": "application/json"}
        body = None
        if payload is not None:
            payload = dict(payload)
            if self.token:
                payload["token"] = self.token
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif self.token:
            params["token"] = self.token
        url = self.host + "/api/" + endpoint
        if params:
            url += "?" + urlencode(params)
        try:
            with urlopen(Request(url, data=body, headers=headers), timeout=self.timeout) as response:
                data = json.load(response)
        except HTTPError as exc:
            raise EagleError(f"Eagle API 返回 HTTP {exc.code}，请检查服务地址及 token。") from None
        except (URLError, TimeoutError, OSError, ValueError) as exc:
            # Do not include a URL carrying an authentication token in errors/logs.
            raise EagleError("无法连接 Eagle，请打开 Eagle 并检查地址、端口和 token。") from None
        if not isinstance(data, dict) or data.get("status") != "success":
            raise EagleError("Eagle API 请求未成功，请检查 Eagle 状态和访问权限。")
        return data.get("data")

    def context(self):
        info = self.request("library/info")
        library = info.get("library", {}) if isinstance(info, dict) else {}
        path = library.get("path") or info.get("path")
        if not isinstance(path, str) or not path:
            raise EagleError("Eagle 没有返回当前素材库路径。")
        root = Path(path).resolve()
        if not root.is_dir():
            raise EagleError("ComfyUI 无法读取 Eagle 素材库路径。Eagle 和 ComfyUI 需在同一台电脑或共享可访问的路径。")
        key = hashlib.sha256(str(root).encode("utf-8")).hexdigest()
        folders = flatten_folders(self.request("folder/list") or [])
        return {"library_key": key, "library_name": library.get("name") or root.stem,
                "root": root, "folders": folders}

    def catalog(self, folder_id, limit=20, include_children=False, expected_library=None, types=None):
        check_limit(limit)
        if not folder_id:
            raise EagleError("请先选择 Eagle 目录，再加载图片。")
        ctx = self.context()
        if expected_library and expected_library != ctx["library_key"]:
            raise EagleError("Eagle 当前素材库已改变，请重新读取目录并选择文件夹。")
        selections = folder_id if isinstance(folder_id, list) else [folder_id]
        if not selections or any(not selected for selected in selections):
            raise EagleError("请先选择 Eagle 目录，再加载资产。")
        folders = []
        for selected in selections:
            folders.extend(folder_ids(ctx["folders"], selected, include_children))
        folders = [] if "__ALL__" in selections else list(dict.fromkeys(folders))
        kinds = types or ["image"]
        if any(kind not in MEDIA_EXTENSIONS for kind in kinds):
            raise EagleError("未知资产类型。")
        params = {"orderBy": "NAME", "limit": min(200, max(limit, 50)), "offset": 0}
        if folders:
            params["folders"] = ",".join(folders)
        items, seen = [], set()
        while len(items) < limit and params["offset"] < 20000:
            page = self.request("item/list", params) or []
            if not isinstance(page, list):
                raise EagleError("Eagle 返回的图片列表无效。")
            for item in page:
                if item.get("isDeleted") or media_type(item) not in kinds or item.get("id") in seen:
                    continue
                # Scope locally too: older Eagle versions can interpret folder filters differently.
                if folders and not set(item.get("folders", [])).intersection(folders):
                    continue
                seen.add(item["id"])
                item = dict(item)
                item["_path"] = str(original_path(ctx["root"], item))
                item["_library_key"] = ctx["library_key"]
                item["media_type"] = media_type(item)
                items.append(item)
                if len(items) == limit:
                    break
            if len(page) < params["limit"]:
                break
            params["offset"] += len(page)
        # Detect library switches during a long scan before using file paths or exporting.
        info = self.request("library/info")
        current_path = (info.get("library", {}) or {}).get("path") or info.get("path")
        if not current_path or Path(current_path).resolve() != ctx["root"]:
            raise EagleError("读取期间 Eagle 切换了素材库，请重新加载。")
        return ctx, items

    def export_paths(self, paths, names, folder_id, expected_library=None, tags=None, annotation=""):
        if not folder_id:
            raise EagleError("保存到 Eagle 已开启，请先选择 Eagle 目标目录。")
        ctx = self.context()
        if expected_library and expected_library != ctx["library_key"]:
            raise EagleError("Eagle 当前素材库已改变，请重新选择导出目录。")
        folder_ids(ctx["folders"], folder_id, False)
        payload = {"items": [{"path": str(Path(path).resolve()), "name": name, "tags": list(tags or []), "annotation": str(annotation or "")}
                             for path, name in zip(paths, names)]}
        if folder_id != "__ALL__":
            payload["folderId"] = folder_id
        return self.request("item/addFromPaths", payload=payload)


def flatten_folders(tree, parents=(), ancestor_ids=()):
    out = []
    for folder in tree:
        folder_id, name = str(folder.get("id", "")), str(folder.get("name", ""))
        if not folder_id or folder_id in ancestor_ids:
            continue
        names = (*parents, name)
        out.append({"id": folder_id, "name": name, "path": " / ".join(names), "ancestors": list(ancestor_ids)})
        out.extend(flatten_folders(folder.get("children", []), names, (*ancestor_ids, folder_id)))
    return out


def folder_ids(folders, selected, include_children):
    if selected == "__ALL__":
        return []
    if selected not in {item["id"] for item in folders}:
        raise EagleError("所选 Eagle 目录不存在，请刷新目录列表。")
    return [item["id"] for item in folders if item["id"] == selected or (include_children and selected in item["ancestors"])]


def original_path(root, item):
    item_id, ext = str(item.get("id", "")), str(item.get("ext", "")).lower()
    if not re.fullmatch(r"[\w-]+", item_id) or ext not in ALL_SUPPORTED:
        raise EagleError("Eagle 图片 ID 或格式无效。")
    directory = (root / "images" / (item_id + ".info")).resolve()
    if not directory.is_relative_to(root.resolve()) or not directory.is_dir():
        raise EagleError("Eagle 原图目录不存在或不可访问。")
    preferred = directory / (str(item.get("name", "")) + "." + ext)
    candidates = [preferred] if preferred.is_file() else sorted(
        p for p in directory.iterdir() if p.is_file() and p.suffix.lower() == "." + ext and not p.stem.endswith("_thumbnail"))
    for path in candidates:
        resolved = path.resolve()
        if resolved.is_relative_to(directory) and resolved.is_file():
            return resolved
    raise EagleError(f"Eagle 图片 {item_id} 的原始文件不存在。")


def name_key(name):
    name = unicodedata.normalize("NFKC", str(name)).strip().casefold()
    suffix = name.rsplit(".", 1)[-1]
    return name.rsplit(".", 1)[0] if suffix in ALL_SUPPORTED and "." in name else name


def query_tokens(query):
    return list(dict.fromkeys(name_key(token) for token in re.split(r"[/\n\r,，;；]+", str(query or "")) if token.strip()))


def select_items(items, query="", selected_ids=None, mode="query", match_mode="exact", strict=True):
    if mode == "manual":
        lookup = {item["id"]: item for item in items}
        ids = list(dict.fromkeys(selected_ids or []))
        missing = [item_id for item_id in ids if item_id not in lookup]
        if missing and strict:
            raise EagleError("部分已选图片不在当前加载范围内，请刷新预览并重新选择，或增大加载上限。")
        return [lookup[item_id] for item_id in ids if item_id in lookup]
    tokens = query_tokens(query)
    result, used, missing = [], set(), []
    for token in tokens:
        matches = [item for item in items if (token in name_key(item.get("name", "")) if match_mode == "contains"
                                            else token == name_key(item.get("name", "")))]
        if not matches:
            missing.append(token)
        for item in matches:
            if item["id"] not in used:
                result.append(item); used.add(item["id"])
    if missing and strict:
        raise EagleError("加载范围内未找到：" + " / ".join(missing) + "。请检查名称、目录和加载上限。")
    return result


def public_item(item):
    result = {key: item.get(key) for key in ("id", "name", "ext", "width", "height", "size", "tags", "folders", "btime", "mtime", "modificationTime", "duration")}
    result["media_type"] = media_type(item)
    return result


@dataclass(frozen=True)
class Asset:
    metadata: dict
    image: torch.Tensor | None = None
    value: object = None
    media_type: str = "image"
    path: str | None = None

    @property
    def payload(self):
        return self.image if self.media_type == "image" else self.value


@dataclass(frozen=True)
class AssetBundle:
    items: tuple[Asset, ...]
    media_type: str = "image"


def load_image(path):
    try:
        with Image.open(path) as source:
            # Still-image assets use the first frame of animated formats, explicitly.
            source.seek(0)
            source = ImageOps.exif_transpose(source)
            rgb = source.convert("RGB")
            array = np.array(rgb, dtype=np.float32) / 255.0
        return torch.from_numpy(array).unsqueeze(0)
    except (OSError, ValueError) as exc:
        raise EagleError("无法读取 Eagle 原图，请检查图片格式与文件权限。") from None


def _number(settings, key, default, minimum, maximum):
    value = settings.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise EagleError(f"{key} 必须在 {minimum}–{maximum} 范围内。")
    return float(value)


def decoder_settings(settings=None):
    settings = settings or {}
    return {
        "video_fps": _number(settings, "video_fps", 24, 1, 60),
        "video_max_seconds": _number(settings, "video_max_seconds", 15, 0.1, 60),
        "video_start_seconds": _number(settings, "video_start_seconds", 0, 0, 86400),
        "video_max_edge": int(_number(settings, "video_max_edge", 768, 64, 2048)),
        "audio_start_seconds": _number(settings, "audio_start_seconds", 0, 0, 86400),
        "audio_max_seconds": _number(settings, "audio_max_seconds", 15, 0.1, 600),
    }


def _ffmpeg():
    executable = shutil.which("ffmpeg")
    if not executable:
        try:
            import imageio_ffmpeg
            executable = imageio_ffmpeg.get_ffmpeg_exe()
        except (ImportError, RuntimeError):
            raise EagleError("视频/音频解码需要 ComfyUI 的 PyAV（av）或 PATH 中的 FFmpeg。") from None
    return executable


def _run_ffmpeg(arguments, input_bytes=None):
    # A list of arguments avoids command-shell interpolation of Eagle names or paths.
    try:
        return subprocess.run([_ffmpeg(), "-hide_banner", "-loglevel", "error", "-nostdin", *arguments],
                              input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=180,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
    except (OSError, subprocess.SubprocessError):
        raise EagleError("媒体解码失败，请检查格式、起始时间和 FFmpeg。") from None


def _scaled_size(width, height, max_edge):
    scale = min(1.0, max_edge / max(width, height))
    return max(1, round(width * scale)), max(1, round(height * scale))


def load_video(path, settings=None):
    config = decoder_settings(settings)
    fps, start, duration, edge = (config[key] for key in ("video_fps", "video_start_seconds", "video_max_seconds", "video_max_edge"))
    max_frames = max(1, math.ceil(fps * duration))
    if max_frames > 360:
        raise EagleError(f"视频解码上限为 360 帧；当前帧率 {fps:g} 时，时长不能超过 {360 / fps:g} 秒。")
    frames = []
    try:
        import av
    except ImportError:
        av = None
    try:
        if av is not None:
            with av.open(str(path)) as container:
                if not container.streams.video:
                    raise EagleError("所选文件没有视频轨道。")
                stream = container.streams.video[0]
                width, height = _scaled_size(stream.codec_context.width, stream.codec_context.height, edge)
                if width * height * max_frames > MAX_VIDEO_PIXELS:
                    raise EagleError("视频帧占用过大，请减小最长边、时长或帧率。")
                origin = float(stream.start_time * stream.time_base) if stream.start_time is not None else 0.0
                if start > 0:
                    container.seek(int((origin + start) * 1_000_000), backward=True, any_frame=False)
                target = start
                previous = None
                source_fps = float(stream.average_rate or fps)
                for index, frame in enumerate(container.decode(video=0)):
                    timestamp = float(frame.time) - origin if frame.time is not None else index / source_fps
                    if timestamp + 1e-6 < start:
                        continue
                    if timestamp >= start + duration:
                        break
                    if timestamp + 1e-6 < target:
                        previous = frame
                        continue
                    image = frame.reformat(width=width, height=height, format="rgb24").to_ndarray()
                    rotation = int(round(getattr(frame, "rotation", 0) // 90)) % 4
                    if rotation:
                        image = np.rot90(image, k=rotation, axes=(0, 1)).copy()
                    # Low-frame-rate sources repeat real decoded frames at the requested fps.
                    while target <= timestamp + 1e-6 and len(frames) < max_frames:
                        frames.append(image.copy())
                        target += 1.0 / fps
                    previous = frame
                    if len(frames) >= max_frames:
                        break
                if previous is not None and frames:
                    end = min(start + duration, timestamp + 1.0 / source_fps)
                    while target < end - 1e-6 and len(frames) < max_frames:
                        frames.append(frames[-1].copy()); target += 1.0 / fps
        else:
            # Decode to a private bounded temporary frame directory; no full video copy.
            with tempfile.TemporaryDirectory(prefix="eagle_video_") as directory:
                filter_text = f"fps={fps},scale=w='min(iw,{edge})':h='min(ih,{edge})':force_original_aspect_ratio=decrease"
                _run_ffmpeg(["-ss", str(start), "-i", str(path), "-t", str(duration), "-an", "-vf", filter_text,
                             "-frames:v", str(max_frames), "-threads", "1", str(Path(directory) / "%05d.png")])
                for filename in sorted(Path(directory).glob("*.png")):
                    with Image.open(filename) as image:
                        if image.width * image.height * max_frames > MAX_VIDEO_PIXELS:
                            raise EagleError("视频帧占用过大，请减小最长边、时长或帧率。")
                        frames.append(np.array(image.convert("RGB"), dtype=np.uint8))
        if not frames:
            raise EagleError("所选视频在设置的时间范围内没有可解码帧。")
        return torch.from_numpy(np.stack(frames).astype(np.float32) / 255.0)
    except EagleError:
        raise
    except Exception:
        raise EagleError("无法解码 Eagle 视频，请检查编码格式与时间范围。") from None


def load_audio(path, settings=None):
    config = decoder_settings(settings)
    start, duration = config["audio_start_seconds"], config["audio_max_seconds"]
    try:
        import av
    except ImportError:
        av = None
    try:
        if av is not None:
            with av.open(str(path)) as container:
                if not container.streams.audio:
                    raise EagleError("所选文件没有音频轨道。")
                stream = container.streams.audio[0]
                rate = int(stream.codec_context.sample_rate)
                if not 1000 <= rate <= 384000:
                    raise EagleError("音频采样率无效。")
                origin = float(stream.start_time * stream.time_base) if stream.start_time is not None else 0.0
                if start:
                    container.seek(int((origin + start) * 1_000_000), backward=True, any_frame=False)
                resampler = av.AudioResampler(format="fltp", layout=stream.layout, rate=rate)
                chunks, cursor = [], 0.0
                for source in container.decode(audio=0):
                    for frame in resampler.resample(source):
                        array = frame.to_ndarray()
                        timestamp = float(frame.time) - origin if frame.time is not None else cursor
                        cursor = timestamp + array.shape[-1] / rate
                        first = max(0, math.ceil((start - timestamp) * rate - 1e-6))
                        last = min(array.shape[-1], math.ceil((start + duration - timestamp) * rate - 1e-6))
                        if last > first:
                            chunks.append(array[:, first:last].copy())
                    if cursor >= start + duration:
                        break
                if not chunks:
                    raise EagleError("所选音频在设置的时间范围内没有可解码声音。")
                array = np.concatenate(chunks, axis=1).astype(np.float32)
        else:
            rate = 48000
            raw = _run_ffmpeg(["-ss", str(start), "-i", str(path), "-t", str(duration), "-vn", "-ac", "2", "-ar", str(rate), "-f", "f32le", "pipe:1"])
            samples = np.frombuffer(raw, dtype="<f4")
            if not samples.size:
                raise EagleError("所选音频在设置的时间范围内没有可解码声音。")
            array = samples.reshape(-1, 2).T.copy()
        waveform = torch.from_numpy(array).unsqueeze(0)
        return {"waveform": waveform, "sample_rate": rate}
    except EagleError:
        raise
    except Exception:
        raise EagleError("无法解码 Eagle 音频，请检查编码格式与时间范围。") from None


def bundle_from_items(items, kind="image", settings=None):
    assets = []
    for item in items:
        if media_type(item) != kind:
            continue
        metadata = public_item(item)
        path = str(Path(item["_path"]).resolve())
        if kind == "image":
            image = load_image(path)
            metadata.update(width=image.shape[2], height=image.shape[1])
            assets.append(Asset(metadata, image=image, path=path))
        elif kind == "video":
            value = load_video(path, settings)
            fps = decoder_settings(settings)["video_fps"]
            metadata.update(width=value.shape[2], height=value.shape[1], fps=fps, frames=value.shape[0], duration=value.shape[0] / fps)
            assets.append(Asset(metadata, value=value, media_type=kind, path=path))
        elif kind == "audio":
            value = load_audio(path, settings)
            metadata.update(duration=value["waveform"].shape[-1] / value["sample_rate"], sample_rate=value["sample_rate"])
            assets.append(Asset(metadata, value=value, media_type=kind, path=path))
        elif kind == "model":
            validate_model_resources(Path(path))
            assets.append(Asset(metadata, value={"path": path, "format": metadata["ext"], "name": metadata["name"]}, media_type=kind, path=path))
    return AssetBundle(tuple(assets), kind)


class SnapshotStore:
    def __init__(self, root):
        self.root = Path(root).resolve()

    def create(self, items, settings=None):
        if not items:
            raise EagleError("请先检索或点选至少一个资产，再锁定输出。")
        sid = uuid.uuid4().hex
        directory = self.root / sid
        directory.mkdir(parents=True)
        manifest = []
        try:
            for index, item in enumerate(items):
                kind = media_type(item)
                metadata = public_item(item)
                source = Path(item["_path"]).resolve()
                if kind == "image":
                    image = load_image(source)
                    filename = f"{index:04d}.png"
                    Image.fromarray(np.rint(image[0].numpy() * 255).astype(np.uint8)).save(directory / filename)
                    metadata.update(width=image.shape[2], height=image.shape[1])
                elif kind == "model":
                    validate_model_resources(source)
                    target = directory / f"{index:04d}"
                    _copy_model_directory(source.parent, target)
                    filename = (target / source.name).relative_to(directory).as_posix()
                elif kind in {"video", "audio"}:
                    filename = f"{index:04d}.{metadata['ext']}"
                    shutil.copyfile(source, directory / filename)
                else:
                    raise EagleError("锁定资产格式不受支持。")
                manifest.append({"metadata": metadata, "file": filename})
            saved = {"version": 2, "items": manifest, "decoder_settings": decoder_settings(settings)}
            (directory / "manifest.json").write_text(json.dumps(saved, ensure_ascii=False), encoding="utf-8")
        except Exception:
            # Only remove the exact freshly generated snapshot under this store.
            if directory.is_relative_to(self.root) and directory.name == sid:
                shutil.rmtree(directory, ignore_errors=True)
            raise
        return {"snapshot_id": sid, "ids": [item["id"] for item in items], "count": len(items)}

    def items(self, sid):
        if not isinstance(sid, str) or not re.fullmatch(r"[0-9a-f]{32}", sid):
            raise EagleError("锁定快照 ID 无效，请解锁并重新锁定。")
        directory = self.root / sid
        try:
            manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
            saved_settings = manifest.get("decoder_settings", {}) if isinstance(manifest, dict) else {}
            manifest = manifest.get("items", []) if isinstance(manifest, dict) else manifest
            items = []
            for item in manifest:
                path = (directory / item["file"]).resolve()
                if not path.is_relative_to(directory):
                    raise EagleError("锁定快照路径无效。")
                if not path.is_file():
                    raise EagleError("锁定快照文件缺失。")
                value = dict(item["metadata"])
                value["_path"] = str(path)
                items.append(value)
            return items, saved_settings
        except (OSError, ValueError, KeyError) as exc:
            raise EagleError("锁定快照已缺失或损坏，请解锁并重新加载、锁定。") from None

    def load(self, sid, kind="image"):
        items, settings = self.items(sid)
        return bundle_from_items(items, kind, settings)


def _copy_model_directory(source, target):
    root = source.resolve()
    target.mkdir(parents=True)
    for child in source.rglob("*"):
        resolved = child.resolve()
        if not resolved.is_relative_to(root) or child.is_symlink():
            raise EagleError("模型包含目录外链接，无法安全锁定。")
        destination = target / child.relative_to(source)
        if child.is_dir():
            destination.mkdir(parents=True, exist_ok=True)
        elif child.is_file():
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(child, destination)


def validate_model_resources(path):
    """Reject external glTF/OBJ resources; never execute model content or pickle."""
    from urllib.parse import unquote
    root = Path(path).parent.resolve()
    def check(value, base=root):
        if str(value).startswith("data:"):
            return
        value = unquote(str(value)).replace("\\", "/")
        if ":" in value or value.startswith("/"):
            raise EagleError("模型引用了素材目录外资源，请在 Eagle 中整理模型及材质文件后重试。")
        resource = (base / value).resolve()
        if not resource.is_relative_to(root) or not resource.is_file():
            raise EagleError("模型材质或贴图缺失，或引用了素材目录外资源。")
    if Path(path).suffix.lower() == ".gltf":
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
            for entry in [*data.get("buffers", []), *data.get("images", [])]:
                if entry.get("uri"):
                    check(entry["uri"])
        except (OSError, ValueError, TypeError):
            raise EagleError("glTF 模型文件无效。") from None
    elif Path(path).suffix.lower() == ".obj":
        for line in Path(path).read_text(encoding="utf-8", errors="replace").splitlines():
            if line.strip().startswith("mtllib "):
                value = line.strip()[7:].strip().strip('"')
                names = [value] if (root / value).is_file() else value.split()
                for name in names:
                    check(name)
                    mtl = root / name
                    for material_line in mtl.read_text(encoding="utf-8", errors="replace").splitlines():
                        parts = material_line.strip().split(maxsplit=1)
                        if len(parts) == 2 and (parts[0].lower().startswith("map_") or parts[0].lower() in {"bump", "disp", "decal"}):
                            candidate = parts[1].strip().strip('"')
                            if candidate.startswith("-"):
                                candidate = candidate.rsplit(maxsplit=1)[-1].strip('"')
                            check(candidate, mtl.parent)


def natural_key(value):
    return tuple((0, int(part)) if part.isdigit() else (1, part.casefold()) for part in re.split(r"(\d+)", str(value)))


def sort_bundle(bundle, mode="input", order=None, descending=False):
    if not isinstance(bundle, AssetBundle):
        raise EagleError("请连接 Eagle 导入或排序节点的 assets 输出。")
    items = list(bundle.items)
    if mode == "manual":
        ranks = {item_id: index for index, item_id in enumerate(dict.fromkeys(order or []))}
        items.sort(key=lambda asset: ranks.get(asset.metadata["id"], len(ranks)))
    elif mode != "input":
        def dimension(asset, index, key):
            tensor = asset.image if asset.media_type == "image" else asset.value if asset.media_type == "video" else None
            return tensor.shape[index] if isinstance(tensor, torch.Tensor) else asset.metadata.get(key) or 0
        keys = {"name": lambda a: natural_key(a.metadata.get("name", "")),
                "created": lambda a: a.metadata.get("btime") or 0,
                "modified": lambda a: a.metadata.get("modificationTime") or a.metadata.get("mtime") or 0,
                "width": lambda a: dimension(a, 2, "width"), "height": lambda a: dimension(a, 1, "height"),
                "duration": lambda a: a.metadata.get("duration") or 0,
                "size": lambda a: a.metadata.get("size") or 0,
                "tags": lambda a: natural_key(",".join(a.metadata.get("tags") or []))}
        if mode not in keys:
            raise EagleError("未知排序字段。")
        items.sort(key=keys[mode], reverse=bool(descending))
    return AssetBundle(tuple(items), bundle.media_type)


def split_bundle(bundle, output_count):
    if not isinstance(bundle, AssetBundle):
        raise EagleError("拆分节点必须连接 Eagle assets。")
    if type(output_count) is not int or not 1 <= output_count <= MAX_OUTPUTS:
        raise EagleError(f"输出数量必须为 1–{MAX_OUTPUTS}。")
    if len(bundle.items) > output_count:
        raise EagleError(f"有 {len(bundle.items)} 张图片，但只设置了 {output_count} 个输出。请增加输出数量，避免丢失资产。")
    # None is deliberately not a tensor or ExecutionBlocker. Qwen 2.1 and T8 skip it.
    values = [asset.value["path"] if asset.media_type == "model" else asset.payload for asset in bundle.items]
    return tuple(values) + (None,) * (MAX_OUTPUTS - len(bundle.items))
