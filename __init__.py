from .nodes import (
    EagleAssetImport, EagleAssetSort, EagleAssetSplit, EagleAssetExport,
    EagleMediaImport, EagleVideoSort, EagleAudioSort, EagleModelSort,
    EagleVideoSplit, EagleAudioSplit, EagleModelSplit, EagleModelToFile3D, EagleStudioBridge, EagleImageStudioBridge,
)
from .media_export import EagleAudioExport, EagleVideoExport, EagleModelExport

NODE_CLASS_MAPPINGS = {
    "EagleAssetImport": EagleAssetImport,
    "EagleAssetSort": EagleAssetSort,
    "EagleAssetSplit": EagleAssetSplit,
    "EagleAssetExport": EagleAssetExport,
    "EagleMediaImport": EagleMediaImport,
    "EagleVideoSort": EagleVideoSort,
    "EagleAudioSort": EagleAudioSort,
    "EagleModelSort": EagleModelSort,
    "EagleVideoSplit": EagleVideoSplit,
    "EagleAudioSplit": EagleAudioSplit,
    "EagleModelSplit": EagleModelSplit,
    "EagleModelToFile3D": EagleModelToFile3D,
    "EagleAudioExport": EagleAudioExport,
    "EagleVideoExport": EagleVideoExport,
    "EagleModelExport": EagleModelExport,
    "EagleStudioBridge": EagleStudioBridge,
    "EagleImageStudioBridge": EagleImageStudioBridge,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "EagleAssetImport": "Eagle 图片导入 · Assets",
    "EagleAssetSort": "Eagle 图片排序 · Assets",
    "EagleAssetSplit": "Eagle 图片拆分 · Assets",
    "EagleAssetExport": "Eagle 图片导出 / 保存 / 预览",
    "EagleMediaImport": "Eagle 多目录媒体导入 · 图片 / 视频 / 音频 / 模型",
    "EagleVideoSort": "Eagle 视频排序 · Assets",
    "EagleAudioSort": "Eagle 音频排序 · Assets",
    "EagleModelSort": "Eagle 模型排序 · Assets",
    "EagleVideoSplit": "Eagle 视频拆分 · T8 帧批次",
    "EagleAudioSplit": "Eagle 音频拆分 · AUDIO",
    "EagleModelSplit": "Eagle 模型拆分 · 文件路径",
    "EagleModelToFile3D": "Eagle 模型路径 → FILE_3D",
    "EagleAudioExport": "Eagle 音频导出 / 保存 / 预览",
    "EagleVideoExport": "Eagle 视频导出 / 保存 / 预览",
    "EagleModelExport": "Eagle 3D 模型导出 / 保存 / 预览",
    "EagleStudioBridge": "Eagle 创作素材桥 · Ollama",
    "EagleImageStudioBridge": "图片直连素材桥 · Ollama",
}
WEB_DIRECTORY = "./web"

from .routes import register_routes
register_routes()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
