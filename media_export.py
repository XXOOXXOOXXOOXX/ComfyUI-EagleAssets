"""Eagle exports for real audio, video and 3D files with independent save switches."""
from fractions import Fraction
from pathlib import Path
import json
import math
import re
import shutil
import tempfile
import uuid
import os
import base64
import mimetypes
import struct
from urllib.parse import unquote, unquote_to_bytes

import numpy as np
import torch

from .core import EagleError, MEDIA_EXTENSIONS, _run_ffmpeg, folder_ids, parse_settings, validate_model_resources
from .nodes import DEFAULT_EXPORT, parse_tags, redact_metadata
from .runtime import client_for, preview_item, _media_url, model_preview_url

FILE3D_INPUT_TYPES = ",".join(("FILE_3D", "FILE_3D_GLB", "FILE_3D_GLTF", "FILE_3D_FBX", "FILE_3D_OBJ", "FILE_3D_STL",
                             "FILE_3D_USDZ", "FILE_3D_PLY", "FILE_3D_SPLAT", "FILE_3D_SPZ", "FILE_3D_KSPLAT",
                             "FILE_3D_SPLAT_ANY", "FILE_3D_POINT_CLOUD_ANY"))


def _schema(required, optional=None):
    return {"required": {**required, "filename_prefix": ("STRING", {"default": "ComfyUI"}),
                         "settings": ("STRING", {"default": DEFAULT_EXPORT})},
            "optional": {**(optional or {}), "tags": ("STRING", {"forceInput": True}),
                         "annotation": ("STRING", {"forceInput": True})},
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"}}


def _metadata(prompt, extra):
    try:
        from comfy.cli_args import args
        if args.disable_metadata:
            return {}
    except ImportError:
        pass
    data = dict(redact_metadata(extra) or {})
    if prompt is not None:
        data["prompt"] = redact_metadata(prompt)
    return data


def _metadata_args(metadata):
    if not metadata:
        return []
    # WAV has a fixed INFO tag set; the comment also preserves complete workflow data.
    result = ["-metadata", "comment=" + json.dumps(metadata, ensure_ascii=False)]
    for key, value in metadata.items():
        if re.fullmatch(r"[\w.-]+", str(key)):
            result.extend(["-metadata", str(key) + "=" + json.dumps(value, ensure_ascii=False)])
    return result


def _destination(settings):
    data = parse_settings(settings)
    client = None
    if data.get("save_eagle"):
        if not data.get("folder_id"):
            raise EagleError("保存到 Eagle 已开启，请先选择 Eagle 目标目录。")
        client = client_for(data)
        context = client.context()
        folder_ids(context["folders"], data["folder_id"], False)
        if data.get("library_key") and data["library_key"] != context["library_key"]:
            raise EagleError("Eagle 当前素材库已变化，请重新选择导出目录。")
    return data, client


def _new_target(prefix, data, ext, batch=0, bundle=False):
    import folder_paths
    kind = "output" if data.get("save_output") else "temp"
    root = Path(folder_paths.get_output_directory() if kind == "output" else folder_paths.get_temp_directory()).resolve()
    prefix = str(prefix or "ComfyUI").replace("%batch_num%", str(batch)).replace("\\", "/")
    if prefix.startswith("/") or re.match(r"^[A-Za-z]:", prefix) or any(part in {"..", "."} for part in prefix.split("/")):
        raise EagleError("文件名前缀必须是保存目录内的相对路径。")
    if hasattr(folder_paths, "get_save_image_path"):
        directory, stem, counter, subfolder, _ = folder_paths.get_save_image_path(prefix, str(root), 0, 0)
        directory = Path(directory).resolve()
    else:
        target_prefix = root / prefix
        directory, stem, counter = target_prefix.parent.resolve(), target_prefix.name, 1
        subfolder = directory.relative_to(root).as_posix() if directory != root else ""
    if not directory.is_relative_to(root):
        raise EagleError("保存路径必须位于 ComfyUI 保存目录内。")
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", stem) or "ComfyUI"
    name = f"{stem}_{counter:05}_{uuid.uuid4().hex[:8]}"
    if bundle:
        directory = directory / name
        subfolder = directory.relative_to(root).as_posix()
        return directory, {"subfolder": subfolder, "type": kind}
    path = directory / (name + "." + ext)
    directory.mkdir(parents=True, exist_ok=True)
    return path, {"filename": path.name, "subfolder": subfolder, "type": kind}


def _audio_values(audio):
    if not isinstance(audio, dict) or not isinstance(audio.get("waveform"), torch.Tensor):
        raise EagleError("音频输入需要标准 AUDIO（waveform 与 sample_rate）。")
    waveform = audio["waveform"]
    rate = audio.get("sample_rate")
    if waveform.ndim != 3 or waveform.shape[1] < 1 or waveform.shape[1] > 8 or waveform.shape[-1] < 1:
        raise EagleError("音频 waveform 必须为 [批次, 1–8声道, 采样点]。")
    if isinstance(rate, bool) or not isinstance(rate, (int, float)) or not math.isfinite(rate) or not 1000 <= rate <= 384000 or int(rate) != rate:
        raise EagleError("音频采样率无效。")
    waveform = waveform.detach().float().cpu()
    if not torch.isfinite(waveform).all():
        raise EagleError("音频包含无效数值。")
    return waveform, int(rate)


def encode_audio(path, waveform, sample_rate, format, metadata=None):
    if format not in {"wav", "flac", "mp3"}:
        raise EagleError("音频格式必须是 WAV、FLAC 或 MP3。")
    channels = waveform.shape[0]
    if format == "mp3" and channels > 2:
        raise EagleError("MP3 最多支持双声道，请选择 WAV 或 FLAC 保留多声道。")
    rate = sample_rate
    if format == "mp3":
        rates = (8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000)
        rate = min(rates, key=lambda candidate: abs(candidate - rate))
    codec = {"wav": "pcm_f32le", "flac": "flac", "mp3": "libmp3lame"}[format]
    layout = {1: "mono", 2: "stereo", 3: "3.0", 4: "quad", 5: "5.0", 6: "5.1", 7: "6.1", 8: "7.1"}[channels]
    try:
        import av
    except ImportError:
        av = None
    if av is not None:
        try:
            with av.open(str(path), mode="w", format=format) as container:
                for key, value in (metadata or {}).items():
                    container.metadata[str(key)] = json.dumps(value, ensure_ascii=False)
                if metadata:
                    container.metadata["comment"] = json.dumps(metadata, ensure_ascii=False)
                stream = container.add_stream(codec, rate=rate, layout=layout)
                if format == "mp3":
                    stream.bit_rate = 320000
                frame = av.AudioFrame.from_ndarray(np.ascontiguousarray(waveform.T.numpy().reshape(1, -1)), format="flt", layout=layout)
                frame.sample_rate, frame.pts = sample_rate, 0
                for packet in stream.encode(frame):
                    container.mux(packet)
                for packet in stream.encode(None):
                    container.mux(packet)
            return rate
        except Exception:
            # A PyAV wheel can lack a requested encoder; an installed FFmpeg is a valid fallback.
            Path(path).unlink(missing_ok=True)
    raw = np.ascontiguousarray(waveform.T.numpy().astype("<f4")).tobytes()
    arguments = ["-y", "-f", "f32le", "-ar", str(sample_rate), "-ac", str(channels), "-i", "pipe:0", "-c:a", codec, "-ar", str(rate)]
    if format == "mp3":
        arguments += ["-b:a", "320k"]
    _run_ffmpeg([*arguments, *_metadata_args(metadata), str(path)], input_bytes=raw)
    return rate


def _frames(frames, fps):
    if not isinstance(frames, torch.Tensor) or frames.ndim != 4 or frames.shape[-1] not in {3, 4} or frames.shape[1] < 1 or frames.shape[2] < 1:
        raise EagleError("视频帧必须是 IMAGE 格式 [帧数, 高, 宽, 3/4通道]。")
    if isinstance(fps, bool) or not isinstance(fps, (int, float)) or not math.isfinite(fps) or not 1 <= fps <= 120:
        raise EagleError("视频帧率必须在 1–120 之间。")
    frames = frames.detach().float().cpu()
    if not torch.isfinite(frames).all():
        raise EagleError("视频帧包含无效数值。")
    return frames


def encode_frames(path, frames, fps, format, audio=None, metadata=None):
    # The current native VIDEO API carries both frames and soundtrack.
    if frames.shape[1] % 2 or frames.shape[2] % 2:
        frames = torch.nn.functional.pad(frames.movedim(-1, 1), (0, frames.shape[2] % 2, 0, frames.shape[1] % 2), mode="replicate").movedim(1, -1)
    try:
        from comfy_api.latest import InputImpl, Types
    except ImportError:
        InputImpl = Types = None
    if InputImpl is not None:
        try:
            video = InputImpl.VideoFromComponents(Types.VideoComponents(images=frames, audio=audio, frame_rate=Fraction(str(fps))))
            video.save_to(str(path), format=Types.VideoContainer(format), codec=Types.VideoCodec("auto"), metadata=metadata or None)
            return
        except (AttributeError, ImportError):
            pass
    with tempfile.TemporaryDirectory(prefix="eagle_video_encode_") as directory:
        raw_path = Path(directory) / "frames.rgb"
        pixels = (frames[..., :3].clamp(0, 1) * 255).round().to(torch.uint8).numpy()
        pixels.tofile(raw_path)
        args = ["-y", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", f"{frames.shape[2]}x{frames.shape[1]}",
                "-framerate", str(fps), "-i", str(raw_path)]
        if audio is not None:
            waveform, rate = _audio_values(audio)
            if waveform.shape[0] != 1:
                raise EagleError("视频配音只接受一个 AUDIO 批次，请先拆分音频。")
            audio_path = Path(directory) / "audio.wav"
            encode_audio(audio_path, waveform[0], rate, "wav")
            args += ["-i", str(audio_path), "-map", "0:v:0", "-map", "1:a:0"]
        codec = "libvpx-vp9" if format == "webm" else "libx264"
        args += ["-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", codec, "-pix_fmt", "yuv420p", "-crf", "18"]
        if format != "webm":
            args += ["-preset", "fast"]
        if audio is not None:
            args += ["-c:a", "libopus" if format == "webm" else "aac", "-t", str(frames.shape[0] / fps)]
        if format == "mp4":
            args += ["-movflags", "+faststart+use_metadata_tags"]
        _run_ffmpeg([*args, *_metadata_args(metadata), str(path)])


def encode_video_path(source, destination, format, metadata):
    try:
        from comfy_api.latest import InputImpl, Types
    except ImportError:
        InputImpl = Types = None
    if InputImpl is not None:
        video = InputImpl.VideoFromFile(str(source))
        video.save_to(str(destination), format=Types.VideoContainer(format), codec=Types.VideoCodec("auto"), metadata=metadata or None)
        return
    try:
        args = ["-y", "-i", str(source), "-map", "0:v:0", "-map", "0:a?", "-c", "copy"]
        if format == "mp4":
            args += ["-movflags", "+faststart+use_metadata_tags"]
        _run_ffmpeg([*args, *_metadata_args(metadata), str(destination)])
    except EagleError:
        codec = "libvpx-vp9" if format == "webm" else "libx264"
        args = ["-y", "-i", str(source), "-map", "0:v:0", "-map", "0:a?", "-c:v", codec,
                "-c:a", "libopus" if format == "webm" else "aac", "-pix_fmt", "yuv420p"]
        _run_ffmpeg([*args, *_metadata_args(metadata), str(destination)])


def _finish(paths, descriptors, data, client, tags, annotation, kind, eagle_paths=None, note=""):
    if client is not None and paths:
        eagle_paths = eagle_paths or paths
        names = [path.stem for path in paths]
        client.export_paths(eagle_paths, names, data["folder_id"], data.get("library_key"),
                            parse_tags(tags if tags is not None else data.get("tags", "")),
                            annotation if annotation is not None else data.get("annotation", ""))
    media = []
    for path, descriptor in zip(paths, descriptors):
        item = {"id": uuid.uuid4().hex, "name": path.stem, "ext": path.suffix[1:], "media_type": kind}
        preview = preview_item(item, path=path)
        preview.update(descriptor)
        if kind == "model":
            preview["preview_url"] = model_preview_url(path)
            preview["media_url"] = _media_url(path, "model")
        media.append(preview)
        preview["annotation"] = str(annotation if annotation is not None else data.get("annotation", ""))
        exported = getattr(client, "last_export_items", []) if client else []
        match = exported[len(media) - 1] if len(exported) >= len(media) else None
        if client is not None:
            index = len(media) - 1
            previous = getattr(client, "last_export_excludes", [])
            preview.update(eagle_saved=True, eagle_folder_id=data["folder_id"], library_key=getattr(client, "last_export_library_key", data.get("library_key")),
                           eagle_ext=(eagle_paths or paths)[index].suffix[1:].lower(), eagle_exclude_ids=previous[index] if index < len(previous) else None)
        if match:
            preview.update(eagle_id=match["id"], library_key=match["library_key"])
    label = {"audio": "音频", "video": "视频", "model": "模型"}[kind]
    ui = {"eagle_media": [media], "eagle_status": [f"预览 {len(paths)} 个{label} ｜ output {'已保存' if data.get('save_output') and paths else '关闭'} ｜ Eagle {'已保存' if client is not None and paths else '关闭'}{note}"]}
    native = [{key: descriptor[key] for key in ("filename", "subfolder", "type")} for descriptor in descriptors]
    if kind == "video":
        ui.update(images=native, animated=(True,), video=native)
    else:
        ui["audio" if kind == "audio" else "3d"] = native
    return {"ui": ui}


def _empty(kind):
    return {"ui": {"eagle_media": [[]], "eagle_status": ["此接口没有素材，跳过预览和保存。"],
                   "audio" if kind == "audio" else "images" if kind == "video" else "3d": []}}


class EagleAudioExport:
    @classmethod
    def INPUT_TYPES(cls):
        return _schema({"audio": ("AUDIO",), "format": (["wav", "flac", "mp3"], {"default": "wav"})})
    RETURN_TYPES = ()
    FUNCTION, CATEGORY, OUTPUT_NODE = "save", "Eagle Assets", True

    def save(self, audio, format="wav", filename_prefix="ComfyUI", settings=DEFAULT_EXPORT, tags=None, annotation=None, prompt=None, extra_pnginfo=None):
        if audio is None:
            return _empty("audio")
        waveform, rate = _audio_values(audio)
        if waveform.shape[0] == 0:
            return _empty("audio")
        if format not in {"wav", "flac", "mp3"}:
            raise EagleError("未知音频保存格式。")
        data, client = _destination(settings)
        metadata = _metadata(prompt, extra_pnginfo)
        paths, descriptors, saved_rate = [], [], rate
        with tempfile.TemporaryDirectory(prefix="eagle_audio_export_") as directory:
            for index, item in enumerate(waveform):
                staged = Path(directory) / f"audio_{index}.{format}"
                saved_rate = encode_audio(staged, item, rate, format, metadata)
                target, descriptor = _new_target(filename_prefix, data, format, index)
                shutil.copyfile(staged, target)
                paths.append(target); descriptors.append(descriptor)
        note = f" ｜ MP3采样率 {rate}→{saved_rate} Hz" if saved_rate != rate else ""
        return _finish(paths, descriptors, data, client, tags, annotation, "audio", note=note)


class EagleVideoExport:
    @classmethod
    def INPUT_TYPES(cls):
        return _schema({"format": (["mp4", "webm", "mkv"], {"default": "mp4"}), "fps": ("FLOAT", {"default": 24, "min": 1, "max": 120})},
                       {"video": ("VIDEO", {"tooltip": "原生 VIDEO；video、path、frames 三者只能连接一种。"}),
                        "path": ("STRING", {"forceInput": True}), "frames": ("IMAGE",), "audio": ("AUDIO", {"tooltip": "仅为 frames 帧批添加配音；原生VIDEO已包含音轨。"})})
    RETURN_TYPES = ()
    FUNCTION, CATEGORY, OUTPUT_NODE = "save", "Eagle Assets", True

    def save(self, format="mp4", fps=24, filename_prefix="ComfyUI", settings=DEFAULT_EXPORT, video=None, path=None, frames=None, audio=None,
             tags=None, annotation=None, prompt=None, extra_pnginfo=None):
        sources = [source for source in (video, path if path else None, frames) if source is not None]
        if not sources:
            return _empty("video")
        if len(sources) != 1:
            raise EagleError("video、path 和 frames 只能提供一种视频来源，请断开多余输入。")
        if audio is not None and frames is None:
            raise EagleError("额外 audio 只用于 frames 视频来源；原生 VIDEO 或视频路径保留自身音轨。")
        if format not in {"mp4", "webm", "mkv"}:
            raise EagleError("未知视频保存格式。")
        source_path = None
        if path:
            source_path = Path(path).resolve()
            if not source_path.is_file() or source_path.suffix[1:].lower() not in MEDIA_EXTENSIONS["video"]:
                raise EagleError("视频路径无效。")
        if frames is not None:
            frames = _frames(frames, fps)
            if frames.shape[0] == 0:
                return _empty("video")
        if video is not None and not callable(getattr(video, "save_to", None)):
            raise EagleError("video 输入必须是原生 VIDEO 对象。")
        data, client = _destination(settings)
        metadata = _metadata(prompt, extra_pnginfo)
        with tempfile.TemporaryDirectory(prefix="eagle_video_export_") as directory:
            staged = Path(directory) / ("video." + format)
            if video is not None:
                try:
                    from comfy_api.latest import Types
                    container, codec = Types.VideoContainer(format), Types.VideoCodec("auto")
                except ImportError:
                    container, codec = format, "auto"
                video.save_to(str(staged), format=container, codec=codec, metadata=metadata or None)
            elif source_path:
                encode_video_path(source_path, staged, format, metadata)
            else:
                encode_frames(staged, frames, fps, format, audio, metadata)
            if not staged.is_file() or staged.stat().st_size == 0:
                raise EagleError("视频保存没有产生有效文件。")
            target, descriptor = _new_target(filename_prefix, data, format)
            shutil.copyfile(staged, target)
        return _finish([target], [descriptor], data, client, tags, annotation, "video")


def model_resources(source):
    """Only the model and declared local companions belong to its export bundle."""
    source = Path(source).resolve()
    validate_model_resources(source)
    root, resources = source.parent, {source}
    def add(value, base=root):
        value = str(value)
        if value.startswith("data:"):
            return None
        file = (base / unquote(value).replace("\\", "/")).resolve()
        if not file.is_relative_to(root) or not file.is_file():
            raise EagleError("模型引用了不可读取的外部材质或贴图。")
        resources.add(file)
        return file
    if source.suffix.lower() == ".gltf":
        data = json.loads(source.read_text(encoding="utf-8"))
        for entry in [*data.get("buffers", []), *data.get("images", [])]:
            if entry.get("uri"):
                add(entry["uri"])
    elif source.suffix.lower() == ".obj":
        for line in source.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.strip().startswith("mtllib "):
                value = line.strip()[7:].strip().strip('"')
                names = [value] if (root / value).is_file() else value.split()
                for name in names:
                    material = add(name)
                    for record in material.read_text(encoding="utf-8", errors="replace").splitlines():
                        parts = record.strip().split(maxsplit=1)
                        if len(parts) == 2 and (parts[0].lower().startswith("map_") or parts[0].lower() in {"bump", "disp", "decal"}):
                            texture = parts[1].strip().strip('"')
                            if texture.startswith("-"):
                                texture = texture.rsplit(maxsplit=1)[-1].strip('"')
                            add(texture, material.parent)
    return sorted(resources)


def _gltf_glb(source):
    """Pack external buffers/images while preserving skins, animations and JSON extensions."""
    data = json.loads(Path(source).read_text(encoding="utf-8"))
    root = Path(source).parent.resolve()
    def read_uri(uri):
        if uri.startswith("data:"):
            header, payload = uri.split(",", 1)
            return base64.b64decode(payload, validate=True) if header.endswith(";base64") else unquote_to_bytes(payload)
        file = (root / unquote(uri)).resolve()
        if not file.is_relative_to(root) or not file.is_file() or ":" in uri:
            raise EagleError("glTF 资源路径无效。")
        return file.read_bytes()
    binary, offsets = bytearray(), []
    for buffer in data.get("buffers", []):
        if not buffer.get("uri"):
            raise EagleError("glTF 外部缓冲区未提供有效 URI。")
        raw = read_uri(buffer["uri"])
        length = buffer.get("byteLength", len(raw))
        if type(length) is not int or length > len(raw) or length < 0:
            raise EagleError("glTF 缓冲区长度无效。")
        binary.extend(b"\0" * ((-len(binary)) % 4))
        offsets.append(len(binary))
        binary.extend(raw[:length])
    views = data.setdefault("bufferViews", [])
    def remap_buffer(record):
        old = record.get("buffer", 0)
        offset = record.get("byteOffset", 0)
        if type(old) is not int or not 0 <= old < len(offsets) or type(offset) is not int or offset < 0:
            raise EagleError("glTF 引用了无效缓冲区或偏移量。")
        record["buffer"], record["byteOffset"] = 0, offsets[old] + offset
    for view in views:
        remap_buffer(view)
        for name, extension in view.get("extensions", {}).items():
            if name in {"EXT_meshopt_compression", "KHR_meshopt_compression"}:
                remap_buffer(extension)
            elif isinstance(extension, dict) and "buffer" in extension:
                raise EagleError("glTF 包含未支持的缓冲区扩展，无法安全打包到 Eagle；请先导出独立 GLB。")
    for image in data.get("images", []):
        if not image.get("uri"):
            continue
        uri = image.pop("uri")
        raw = read_uri(uri)
        binary.extend(b"\0" * ((-len(binary)) % 4))
        image["bufferView"] = len(views)
        if "mimeType" not in image:
            image["mimeType"] = uri[5:].split(";", 1)[0] if uri.startswith("data:") else mimetypes.guess_type(uri)[0] or "application/octet-stream"
        views.append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(raw)})
        binary.extend(raw)
    data["buffers"] = [{"byteLength": len(binary)}]
    # JSON may contain animation/skin/extension structures; all are retained verbatim.
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    text += b" " * ((-len(text)) % 4)
    binary.extend(b"\0" * ((-len(binary)) % 4))
    length = 12 + 8 + len(text) + 8 + len(binary)
    return struct.pack("<4sII", b"glTF", 2, length) + struct.pack("<I4s", len(text), b"JSON") + text + struct.pack("<I4s", len(binary), b"BIN\0") + binary


def _self_contained_glb(source, destination):
    if source.suffix.lower() == ".gltf":
        destination.write_bytes(_gltf_glb(source))
        return
    try:
        import trimesh
    except ImportError:
        raise EagleError("OBJ 含外部材质，保存到 Eagle 需 trimesh 打包 GLB；请安装插件 requirements.txt，或先仅保存到 output。") from None
    try:
        scene = trimesh.load(str(source), force="scene", process=False)
        destination.write_bytes(scene.export(file_type="glb"))
    except Exception:
        raise EagleError("无法将模型及材质打包成独立 GLB，尚未导入 Eagle。") from None


class EagleModelExport:
    @classmethod
    def INPUT_TYPES(cls):
        return _schema({}, {"model_3d": (FILE3D_INPUT_TYPES,), "path": ("STRING", {"forceInput": True}), "mesh": ("MESH",)})
    RETURN_TYPES = ()
    FUNCTION, CATEGORY, OUTPUT_NODE = "save", "Eagle Assets", True

    def save(self, filename_prefix="ComfyUI", settings=DEFAULT_EXPORT, model_3d=None, path=None, mesh=None,
             tags=None, annotation=None, prompt=None, extra_pnginfo=None):
        sources = [source for source in (model_3d, path if path else None, mesh) if source is not None]
        if not sources:
            return _empty("model")
        if len(sources) != 1:
            raise EagleError("model_3d、path 和 mesh 只能提供一种模型来源。")
        source_path = Path(path).resolve() if path else None
        if model_3d is not None:
            if not callable(getattr(model_3d, "save_to", None)):
                raise EagleError("model_3d 必须是原生 FILE_3D 对象。")
            getter = getattr(model_3d, "get_source", None)
            original = getter() if callable(getter) else None
            if isinstance(original, (str, os.PathLike)):
                source_path = Path(original).resolve()
        if source_path is not None and (not source_path.is_file() or source_path.suffix[1:].lower() not in MEDIA_EXTENSIONS["model"]):
            raise EagleError("模型文件路径无效。")
        if source_path is not None:
            resources = model_resources(source_path)
        if mesh is not None:
            vertices = getattr(mesh, "vertices", None)
            if not isinstance(vertices, torch.Tensor) or vertices.ndim != 3:
                raise EagleError("mesh 需要官方 MESH 类型的批次顶点与面数据。")
            if vertices.shape[0] == 0:
                return _empty("model")
        data, client = _destination(settings)
        metadata = _metadata(prompt, extra_pnginfo)
        paths, descriptors, eagle_paths, converted = [], [], [], False
        with tempfile.TemporaryDirectory(prefix="eagle_model_export_") as directory:
            stage = Path(directory)
            staged = []
            if source_path is not None:
                source_dir = stage / "original"
                source_dir.mkdir()
                for resource in resources:
                    target = source_dir / resource.relative_to(source_path.parent)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(resource, target)
                staged.append(source_dir / source_path.name)
            elif model_3d is not None:
                format = str(getattr(model_3d, "format", "") or "glb").lower().lstrip(".")
                if format not in MEDIA_EXTENSIONS["model"]:
                    raise EagleError("FILE_3D 模型格式不受支持。")
                target = stage / "original" / ("model." + format)
                target.parent.mkdir()
                model_3d.save_to(str(target))
                model_resources(target)  # Memory-backed external-resource models must be complete.
                staged.append(target)
            else:
                try:
                    from comfy_extras.nodes_save_3d import mesh_item_to_glb_bytes
                except ImportError:
                    raise EagleError("导出 MESH 需要当前 ComfyUI 的官方 3D 保存能力，请升级 ComfyUI。") from None
                for index in range(mesh.vertices.shape[0]):
                    payload = mesh_item_to_glb_bytes(mesh, index, metadata)
                    if payload is None:
                        continue
                    target = stage / str(index) / "model.glb"
                    target.parent.mkdir(); target.write_bytes(payload)
                    staged.append(target)
            if not staged:
                return _empty("model")
            # Prepare Eagle packages before any persistent output is written.
            for index, source in enumerate(staged):
                companions = model_resources(source)
                if client is not None and source.suffix.lower() in {".gltf", ".obj"} and (len(companions) > 1 or source.suffix.lower() == ".gltf"):
                    packed = stage / f"eagle_{index}.glb"
                    _self_contained_glb(source, packed)
                    eagle_paths.append(packed); converted = True
                else:
                    eagle_paths.append(source)
            for index, source in enumerate(staged):
                directory, descriptor = _new_target(filename_prefix, data, source.suffix[1:], index, bundle=True)
                directory.mkdir(parents=True)
                primary = directory / (directory.name + source.suffix)
                for resource in model_resources(source):
                    target = primary if resource == source else directory / resource.relative_to(source.parent)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(resource, target)
                target = primary
                descriptor["filename"] = target.name
                paths.append(target); descriptors.append(descriptor)
            # API imports happen while the staged standalone packages still exist.
            note = " ｜ Eagle 已打包为独立 GLB（本地保留原格式及材质）" if converted else ""
            return _finish(paths, descriptors, data, client, tags, annotation, "model", eagle_paths=eagle_paths, note=note)
