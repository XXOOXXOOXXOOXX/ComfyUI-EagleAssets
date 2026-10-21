"""Connection-only pass-through for export nodes; never forwards media or local save settings."""
from .core import EagleError, parse_settings

TARGET_TYPE = "EAGLE_EXPORT_TARGET"
TARGET_FIELDS = ("host", "token", "library_key", "library_name", "folder_id", "folder_label", "save_eagle", "_bridge_auth")
TARGET_INPUT = (TARGET_TYPE, {"tooltip": "连接上游导出的 eagle_target，沿用其 Eagle 连接、目录和保存到 Eagle 开关；本节点的 output、文件名、标签和注释仍独立。"})


def resolve_target(settings, eagle_target=None):
    data = dict(settings) if isinstance(settings, dict) else parse_settings(settings)
    if eagle_target is not None:
        if not isinstance(eagle_target, dict) or type(eagle_target.get("version")) is not int or eagle_target["version"] != 1:
            raise EagleError("上游 Eagle 目录配置无效，请连接导出节点的 eagle_target 输出。")
        data.update({key: eagle_target.get(key) for key in TARGET_FIELDS})
    return data


def target_result(result, data):
    result["result"] = ({"version": 1, **{key: data.get(key) for key in TARGET_FIELDS}},)
    return result
