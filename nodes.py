import json
from pathlib import Path
import uuid
import re

import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo

from .core import (AssetBundle, EagleError, MAX_OUTPUTS, bundle_from_items, parse_settings,
                   select_items, sort_bundle, split_bundle, MEDIA_EXTENSIONS, decoder_settings, validate_model_resources)
from .runtime import catalog_for, client_for, preview_item, publish_catalog, snapshot_store, snapshot_previews, studio_catalog, publish_studio_images
from .export_target import TARGET_TYPE, TARGET_INPUT, resolve_target, target_result

DEFAULT_IMPORT = json.dumps({"version": 1, "host": "http://localhost:41595", "token": "", "folder_id": "", "limit": 20,
    "include_children": False, "manual_query": "", "selection_mode": "manual", "selected_ids": [], "locked": None, "match_mode": "exact", "text_locked": False,
    "preview_loaded": False})
DEFAULT_SORT = '{"version":1,"mode":"manual","order":[],"descending":false,"filter_mode":true,"selected_ids":[]}'
DEFAULT_BRIDGE = '{"version":1,"selected_ids":[]}'
DEFAULT_MEDIA_IMPORT = json.dumps({**json.loads(DEFAULT_IMPORT), "folder_count": 1, "folder_ids": [""], "types": [],
                                  **decoder_settings()})
DEFAULT_EXPORT = json.dumps({"version": 1, "host": "http://localhost:41595", "token": "", "folder_id": "", "save_eagle": False, "save_output": False})


class EagleAssetImport:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"settings": ("STRING", {"default": DEFAULT_IMPORT})},
                "optional": {"query": ("STRING", {"forceInput": True, "tooltip": "可连接其他节点输出的 1/2/3/4；未锁定时每次执行重新检索。"})}}
    RETURN_TYPES = ("EAGLE_ASSETS",)
    RETURN_NAMES = ("assets",)
    FUNCTION = "load"
    CATEGORY = "Eagle Assets"

    @classmethod
    def IS_CHANGED(cls, settings, query=None):
        data = parse_settings(settings)
        if data.get("locked"):
            return data["locked"]["snapshot_id"]
        return float("nan")

    def load(self, settings, query=None):
        data = parse_settings(settings)
        catalog_id = None
        if data.get("locked"):
            bundle = snapshot_store().load(data["locked"]["snapshot_id"])
            status = "已锁定输出"
            previews = [preview_item(asset.metadata, asset.path) for asset in bundle.items]
            catalog = previews
        else:
            ctx, items = catalog_for(data)
            if query is not None:
                selected = select_items(items, query=query, match_mode=data.get("match_mode", "exact"))
            else:
                selected = select_items(items, query=data.get("manual_query", ""), selected_ids=data.get("selected_ids", []),
                    mode=data.get("selection_mode", "manual"), match_mode=data.get("match_mode", "exact"))
            bundle = bundle_from_items(selected)
            prepared = publish_catalog(data, ctx, items)
            catalog, catalog_id = prepared["items"], prepared["catalog_id"]
            lookup = {item["id"]: item for item in catalog}
            previews = [lookup[asset.metadata["id"]] for asset in bundle.items]
            status = f"实时读取：{len(bundle.items)} 张输出"
        return {"ui": {"eagle_assets": [previews], "eagle_catalog": [catalog], "eagle_catalog_id": [catalog_id],
                       "eagle_status": [status]}, "result": (bundle,)}


class EagleMediaImport(EagleAssetImport):
    @classmethod
    def INPUT_TYPES(cls):
        schema = super().INPUT_TYPES()
        schema["required"]["settings"] = ("STRING", {"default": DEFAULT_MEDIA_IMPORT})
        return schema

    RETURN_TYPES = ("EAGLE_ASSETS", "EAGLE_VIDEO_ASSETS", "EAGLE_AUDIO_ASSETS", "EAGLE_MODEL_ASSETS", "EAGLE_MEDIA_CATALOG")
    RETURN_NAMES = ("image_assets", "video_assets", "audio_assets", "model_assets", "media_catalog")

    def load(self, settings, query=None):
        data = parse_settings(settings)
        if data.get("locked"):
            selected, saved_config = snapshot_store().items(data["locked"]["snapshot_id"])
            bundles = tuple(bundle_from_items(selected, kind, saved_config) for kind in MEDIA_EXTENSIONS)
            previews = snapshot_previews(data["locked"]["snapshot_id"])
            catalog, catalog_id, status = previews, None, "已锁定输出（媒体快照）"
        else:
            ctx, items = catalog_for(data)
            selected = select_items(items, query=query if query is not None else data.get("manual_query", ""),
                                    selected_ids=data.get("selected_ids", []), mode="query" if query is not None else data.get("selection_mode", "manual"),
                                    match_mode=data.get("match_mode", "exact"))
            # Only selected assets are decoded. Preview catalogs never decode complete videos/audio.
            bundles = tuple(bundle_from_items(selected, kind, data) for kind in MEDIA_EXTENSIONS)
            prepared = publish_catalog(data, ctx, items)
            catalog, catalog_id = prepared["items"], prepared["catalog_id"]
            lookup = {item["id"]: item for item in catalog}
            previews = [dict(lookup[item["id"]]) for item in selected]
            metadata = {asset.metadata["id"]: asset.metadata for bundle in bundles for asset in bundle.items}
            for descriptor in previews:
                descriptor.update(metadata[descriptor["id"]])
            status = "实时读取：" + " / ".join(f"{len(bundle.items)} {name}" for bundle, name in zip(bundles, ("图片", "视频", "音频", "模型")))
        reference = studio_catalog(snapshot_id=data["locked"]["snapshot_id"]) if data.get("locked") else studio_catalog(catalog_id=catalog_id)
        return {"ui": {"eagle_assets": [previews], "eagle_catalog": [catalog], "eagle_catalog_id": [catalog_id],
                       "eagle_catalog_ref": [reference], "eagle_status": [status]}, "result": (*bundles, reference)}


class EagleAssetSort:
    ASSET_TYPE = "EAGLE_ASSETS"
    MEDIA_TYPE = "image"
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"assets": (cls.ASSET_TYPE,), "sort_settings": ("STRING", {"default": DEFAULT_SORT})}}
    RETURN_TYPES = ("EAGLE_ASSETS",)
    RETURN_NAMES = ("assets",)
    FUNCTION = "sort"
    CATEGORY = "Eagle Assets"

    def sort(self, assets, sort_settings):
        if not isinstance(assets, AssetBundle) or assets.media_type != self.MEDIA_TYPE:
            raise EagleError("排序节点连接的资产类型不匹配。")
        data = parse_settings(sort_settings)
        input_items = assets.items
        if data.get("filter_mode", False):
            lookup = {asset.metadata["id"]: asset for asset in assets.items}
            selected = data.get("selected_ids", [])
            if not isinstance(selected, list) or any(not isinstance(item_id, str) for item_id in selected):
                raise EagleError("点选素材 ID 必须是文字列表。")
            ids = list(dict.fromkeys(selected))
            # A script can replace this node's input each batch. Stale selections become empty slots.
            assets = AssetBundle(tuple(lookup[item_id] for item_id in ids if item_id in lookup), assets.media_type)
        result = sort_bundle(assets, data.get("mode", "input"), data.get("order", []), data.get("descending", False))
        # Pixels can be different sizes; the asset bundle preserves original sizes without padding/resizing.
        previews = []
        for asset in input_items:
            image = None
            tensor = asset.image if self.MEDIA_TYPE == "image" else asset.value if self.MEDIA_TYPE == "video" else None
            if tensor is not None:
                image = Image.fromarray(np.rint(tensor[0].cpu().numpy().clip(0, 1) * 255).astype(np.uint8))
            descriptor = preview_item(asset.metadata, path=asset.path, image=image)
            descriptor.update(asset.metadata)
            previews.append(descriptor)
        lookup = {item["id"]: item for item in previews}
        selected_previews = [lookup[asset.metadata["id"]] for asset in result.items]
        return {"ui": {"eagle_assets": [selected_previews], "eagle_catalog": [previews]}, "result": (result,)}


class EagleAssetSplit:
    ASSET_TYPE = "EAGLE_ASSETS"
    MEDIA_TYPE = "image"
    DEFAULT_COUNT = 9
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"assets": (cls.ASSET_TYPE,), "output_count": ("INT", {"default": cls.DEFAULT_COUNT, "min": 1, "max": MAX_OUTPUTS, "step": 1})}}
    # Stable backend slots allow saved links to validate; the frontend shows only output_count sockets.
    RETURN_TYPES = ("IMAGE",) * MAX_OUTPUTS
    RETURN_NAMES = tuple(f"image_{i}" for i in range(1, MAX_OUTPUTS + 1))
    FUNCTION = "split"
    CATEGORY = "Eagle Assets"

    def split(self, assets, output_count=9):
        if not isinstance(assets, AssetBundle) or assets.media_type != self.MEDIA_TYPE:
            raise EagleError("拆分节点连接的资产类型不匹配。")
        return split_bundle(assets, output_count)


class EagleVideoSort(EagleAssetSort):
    ASSET_TYPE, MEDIA_TYPE = "EAGLE_VIDEO_ASSETS", "video"
    RETURN_TYPES, RETURN_NAMES = ("EAGLE_VIDEO_ASSETS",), ("assets",)


class EagleAudioSort(EagleAssetSort):
    ASSET_TYPE, MEDIA_TYPE = "EAGLE_AUDIO_ASSETS", "audio"
    RETURN_TYPES, RETURN_NAMES = ("EAGLE_AUDIO_ASSETS",), ("assets",)


class EagleModelSort(EagleAssetSort):
    ASSET_TYPE, MEDIA_TYPE = "EAGLE_MODEL_ASSETS", "model"
    RETURN_TYPES, RETURN_NAMES = ("EAGLE_MODEL_ASSETS",), ("assets",)


class EagleVideoSplit(EagleAssetSplit):
    ASSET_TYPE, MEDIA_TYPE, DEFAULT_COUNT = "EAGLE_VIDEO_ASSETS", "video", 3
    RETURN_TYPES = ("IMAGE",) * MAX_OUTPUTS
    RETURN_NAMES = tuple(f"video_{i}" for i in range(1, MAX_OUTPUTS + 1))

    def split(self, assets, output_count=3):
        return super().split(assets, output_count)


class EagleAudioSplit(EagleAssetSplit):
    ASSET_TYPE, MEDIA_TYPE, DEFAULT_COUNT = "EAGLE_AUDIO_ASSETS", "audio", 3
    RETURN_TYPES = ("AUDIO",) * MAX_OUTPUTS
    RETURN_NAMES = tuple(f"audio_{i}" for i in range(1, MAX_OUTPUTS + 1))

    def split(self, assets, output_count=3):
        return super().split(assets, output_count)


class EagleModelSplit(EagleAssetSplit):
    ASSET_TYPE, MEDIA_TYPE = "EAGLE_MODEL_ASSETS", "model"
    RETURN_TYPES = ("STRING",) * MAX_OUTPUTS
    RETURN_NAMES = tuple(f"model_{i}" for i in range(1, MAX_OUTPUTS + 1))


class EagleModelToFile3D:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"path": ("STRING", {"forceInput": True})}}
    RETURN_TYPES, RETURN_NAMES = ("FILE_3D",), ("model_3d",)
    FUNCTION, CATEGORY = "convert", "Eagle Assets"

    def convert(self, path):
        if path is None or path == "":
            return (None,)
        file = Path(path).resolve()
        if not file.is_file() or file.suffix.lower().lstrip(".") not in MEDIA_EXTENSIONS["model"]:
            raise EagleError("请连接 Eagle 模型拆分节点的有效模型路径。")
        validate_model_resources(file)
        try:
            from comfy_api.latest import Types
            file_type = Types.File3D
        except (ImportError, AttributeError):
            raise EagleError("当前 ComfyUI 不支持 FILE_3D，请升级 ComfyUI，或直接将模型路径连接第三方模型加载节点。") from None
        return (file_type(str(file)),)


class ImageBridgeInputs(dict):
    """Advertise one socket, accept any numbered IMAGE socket at execution."""
    def __contains__(self, key):
        return isinstance(key, str) and re.fullmatch(r"image_[1-9]\d*", key) is not None

    def __getitem__(self, key):
        if key in self:
            return ("IMAGE",)
        raise KeyError(key)


class EagleImageStudioBridge:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}, "optional": ImageBridgeInputs({"image_1": ("IMAGE",)})}

    RETURN_TYPES = ()
    FUNCTION, CATEGORY, OUTPUT_NODE = "publish", "Eagle Assets", True

    def publish(self, **images):
        ordered = sorted(((int(key[6:]), value) for key, value in images.items() if key in ImageBridgeInputs() and value is not None), key=lambda pair: pair[0])
        return {"ui": {"eagle_image_studio": [publish_studio_images(ordered)]}}


class EagleStudioBridge:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"media": ("EAGLE_MEDIA_CATALOG",), "settings": ("STRING", {"default": DEFAULT_BRIDGE})}}
    RETURN_TYPES, RETURN_NAMES = ("EAGLE_MEDIA_CATALOG",), ("media_catalog",)
    FUNCTION, CATEGORY, OUTPUT_NODE = "publish", "Eagle Assets", True

    def publish(self, media, settings=DEFAULT_BRIDGE):
        if not isinstance(media, dict):
            raise EagleError("请连接 Eagle 多目录媒体导入节点的媒体目录输出。")
        data = parse_settings(settings)
        catalog = studio_catalog(media.get("catalog_id"), media.get("snapshot_id"))
        selected = data.get("selected_ids", [])
        if not isinstance(selected, list) or any(not isinstance(item_id, str) for item_id in selected):
            raise EagleError("素材桥的点选素材 ID 必须是文字列表。")
        lookup = {item["id"]: item for item in catalog["items"]}
        ids = list(dict.fromkeys(selected))
        missing = [item_id for item_id in ids if item_id not in lookup]
        # Saved selections can outlive a live folder listing or refer to assets
        # outside the upstream locked snapshot. Keep only this execution's assets;
        # never expand an empty selection to the whole gallery or break the queue.
        catalog["items"] = [lookup[item_id] for item_id in ids if item_id in lookup]
        status = f"创作素材桥：{len(catalog['items'])} 个素材可引用"
        if missing:
            status += f" · 已跳过 {len(missing)} 个当前上游未提供的选择，可在素材桥重新点选"
        return {"ui": {"eagle_studio_catalog": [catalog], "eagle_status": [status],
                       "eagle_studio_skipped_ids": [missing]}, "result": (catalog,)}


def redact_metadata(value):
    """Generated PNG metadata must not copy Eagle credentials into Eagle or output files."""
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if key in {"token", "eagle_token", "_bridge_auth", "bridge_auth"}:
                result[key] = ""
            else:
                result[key] = redact_metadata(item)
        return result
    if isinstance(value, list):
        return [redact_metadata(item) for item in value]
    if isinstance(value, str) and value.lstrip().startswith(("{", "[")):
        try:
            return json.dumps(redact_metadata(json.loads(value)), ensure_ascii=False)
        except (TypeError, ValueError):
            pass
    return value


class EagleAssetExport:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",), "filename_prefix": ("STRING", {"default": "ComfyUI"}),
                             "settings": ("STRING", {"default": DEFAULT_EXPORT})},
                "optional": {"tags": ("STRING", {"forceInput": True, "tooltip": "连接后覆盖手动标签；逗号、换行或 JSON 字符串数组分隔。"}),
                             "annotation": ("STRING", {"forceInput": True, "tooltip": "连接后覆盖手动 Eagle 注释，保留完整提示词。"}),
                             "eagle_target": TARGET_INPUT},
                "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"}}
    RETURN_TYPES = (TARGET_TYPE,)
    RETURN_NAMES = ("eagle_target",)
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "Eagle Assets"

    def save(self, images, filename_prefix="ComfyUI", settings=DEFAULT_EXPORT, prompt=None, extra_pnginfo=None, tags=None, annotation=None, eagle_target=None):
        import folder_paths
        from nodes import SaveImage, PreviewImage
        data = resolve_target(settings, eagle_target)
        to_output, to_eagle = bool(data.get("save_output")), bool(data.get("save_eagle"))
        if images is None:
            return target_result({"ui": {"images": [], "eagle_media": [[]], "eagle_status": ["此接口没有图片，跳过预览和保存。"]}}, data)
        if to_eagle:
            # Validate destination before creating any persistent output image.
            client = client_for(data)
            ctx = client.context()
            from .core import folder_ids
            if not data.get("folder_id"):
                raise EagleError("保存到 Eagle 已开启，请先选择 Eagle 目录。")
            folder_ids(ctx["folders"], data["folder_id"], False)
            if data.get("library_key") and ctx["library_key"] != data["library_key"]:
                raise EagleError("Eagle 当前素材库已变化，请重新选择导出目录。")
            data["library_key"] = ctx["library_key"]
        clean_prompt, clean_extra = redact_metadata(prompt), redact_metadata(extra_pnginfo)
        # Use native save and preview nodes for counters, subfolders, workflow PNG metadata and UI image descriptors.
        saver = SaveImage() if to_output else PreviewImage()
        result = saver.save_images(images, filename_prefix=filename_prefix, prompt=clean_prompt, extra_pnginfo=clean_extra)
        descriptors = result.get("ui", {}).get("images", [])
        if to_eagle and descriptors:
            root = Path(folder_paths.get_output_directory() if to_output else folder_paths.get_temp_directory())
            paths = [root / item.get("subfolder", "") / item["filename"] for item in descriptors]
            client.export_paths(paths, [path.stem for path in paths], data["folder_id"], data.get("library_key"),
                                parse_tags(tags if tags is not None else data.get("tags", "")),
                                annotation if annotation is not None else data.get("annotation", ""))
        status = f"预览 {len(descriptors)} 张 ｜ output {'已保存' if to_output else '关闭'} ｜ Eagle {'已保存' if to_eagle else '关闭'}"
        result.setdefault("ui", {})["eagle_status"] = [status]
        exported = getattr(client, "last_export_items", []) if to_eagle else []
        previews = []
        for index, descriptor in enumerate(descriptors):
            item = {**descriptor, "media_type": "image", "name": Path(descriptor["filename"]).stem, "ext": "png",
                    "annotation": str(annotation if annotation is not None else data.get("annotation", ""))}
            if to_eagle:
                previous = getattr(client, "last_export_excludes", [])
                item.update(eagle_saved=True, eagle_folder_id=data["folder_id"], eagle_ext="png", library_key=getattr(client, "last_export_library_key", data.get("library_key")),
                            eagle_exclude_ids=previous[index] if index < len(previous) else None)
            match = exported[index] if index < len(exported) else None
            if match: item.update(eagle_id=match["id"], library_key=match["library_key"])
            previews.append(item)
        result["ui"]["eagle_media"] = [previews]
        # Keep native file descriptors for history and the Assets sidebar.
        # Only the node's canvas renderer is suppressed by the frontend; the
        # shared execution result must remain usable by ComfyUI itself.
        return target_result(result, data)


def parse_tags(value):
    value = str(value or "").strip()
    if value.startswith("["):
        try:
            tags = json.loads(value)
        except ValueError:
            raise EagleError("标签 JSON 格式无效，请使用字符串数组。") from None
        if not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags):
            raise EagleError("标签 JSON 必须是字符串数组。")
    else:
        tags = re.split(r"[,，;；\r\n]+", value)
    return list(dict.fromkeys(tag.strip() for tag in tags if tag.strip()))
