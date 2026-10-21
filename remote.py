"""Materialize remote Eagle originals through an outbound desktop agent."""
import sys
from pathlib import Path
import re
from .core import EagleClient, EagleError, flatten_folders, folder_ids, original_path, media_type, check_limit, MEDIA_EXTENSIONS


class RemoteEagleClient(EagleClient):
    def __init__(self, settings):
        self.device = str(settings.get("host", ""))[9:]
        self.auth = settings.get("_bridge_auth", "")
        self.bridge = sys.modules.get("_comfy_desktop_bridge")
        if not self.bridge:
            raise EagleError("请同时安装并启用 ComfyUI-DesktopBridge，再重启 ComfyUI。")
        if not re.fullmatch(r"[a-f0-9]{32}", self.device):
            raise EagleError("电脑桥接地址无效，请在节点中重新选择已配对的电脑。")
        from importlib import import_module
        self.files = import_module(self.bridge.__package__ + ".files")
        self._ctx = None

    def rpc(self, operation, payload=None):
        try:
            return self.bridge.call(self.device, "eagle." + operation, payload, self.auth, timeout=180 if operation in {"files", "export"} else 30)
        except (ValueError, TimeoutError) as exc:
            raise EagleError(str(exc)) from None

    def context(self):
        import folder_paths
        data = self.rpc("context")
        if not re.fullmatch(r"[a-f0-9]{64}", str(data.get("library_key", ""))):
            raise EagleError("远程素材库标识无效。")
        root = Path(folder_paths.get_user_directory()) / "desktop_bridge" / "cache" / self.device / data["library_key"]
        root.mkdir(parents=True, exist_ok=True)
        self._ctx = {"root": root.resolve(), "library_key": data["library_key"], "library_name": data["library_name"], "folders": flatten_folders(data["folders_tree"])}
        return self._ctx

    def materialize(self, item):
        ctx = self._ctx or self.context()
        if not re.fullmatch(r"[\w-]+", str(item.get("id", ""))):
            raise EagleError("远程素材 ID 无效。")
        data = self.rpc("files", {"id": item["id"], "library_key": ctx["library_key"]})
        directory = ctx["root"] / "images" / (item["id"] + ".info")
        self.files.unpack(data["bundle"], directory)
        item.update(data["item"])
        return original_path(ctx["root"], item)

    def request(self, endpoint, params=None, payload=None):
        ctx = self._ctx or self.context()
        if endpoint == "library/info":
            latest = self.rpc("context")
            if latest["library_key"] != ctx["library_key"]:
                raise EagleError("远程 Eagle 已切换素材库，请刷新。")
            return {"library": {"path": str(ctx["root"]), "name": ctx["library_name"]}}
        if endpoint == "item/update":
            return self.rpc("rename", {**(payload or {}), "library_key": ctx["library_key"]})
        data = self.rpc("request", {"endpoint": endpoint, "params": params or {}, "library_key": ctx["library_key"]})
        if endpoint == "item/info" and isinstance(data, dict):
            self.materialize(data)
        return data

    def catalog(self, folder_id, limit=20, include_children=False, expected_library=None, types=None):
        check_limit(limit)
        ctx = self.context()
        if expected_library and expected_library != ctx["library_key"]:
            raise EagleError("远程 Eagle 已切换素材库，请重新读取目录。")
        selections = folder_id if isinstance(folder_id, list) else [folder_id]
        folders = []
        for selected in selections:
            folders.extend(folder_ids(ctx["folders"], selected, include_children))
        folders = [] if "__ALL__" in selections else list(set(folders))
        kinds = types or ["image"]
        if any(kind not in MEDIA_EXTENSIONS for kind in kinds):
            raise EagleError("未知资产类型")
        items, seen, offset = [], set(), 0
        while len(items) < limit and offset < 20000:
            params = {"offset": offset, "limit": min(200, max(50, limit)), "orderBy": "NAME"}
            if folders:
                params["folders"] = ",".join(folders)
            page = self.request("item/list", params) or []
            for value in page:
                item = dict(value)
                if item.get("isDeleted") or item.get("id") in seen or media_type(item) not in kinds or folders and not set(item.get("folders", [])).intersection(folders):
                    continue
                seen.add(item["id"])
                path = self.materialize(item)
                item.update(_path=str(path), _library_key=ctx["library_key"], media_type=media_type(item))
                items.append(item)
                if len(items) >= limit:
                    break
            if len(page) < params["limit"]:
                break
            offset += len(page)
        self.request("library/info")
        return ctx, items

    def export_paths(self, paths, names, folder_id, expected_library=None, tags=None, annotation=""):
        ctx = self.context()
        if expected_library and expected_library != ctx["library_key"]:
            raise EagleError("远程 Eagle 已切换素材库，请重新选择导出目录。")
        folder_ids(ctx["folders"], folder_id, False)
        items = []
        total = 0
        for path, name in zip(paths, names):
            path = Path(path).resolve()
            files = [path]
            if path.suffix[1:].lower() in MEDIA_EXTENSIONS["model"]:
                from .media_export import model_resources
                files = model_resources(path)
            total += sum(file.stat().st_size for file in files)
            if total > 128 * 1024 * 1024:
                raise EagleError("本批远程导出超过 128 MB，请减少批次数或拆分导出。")
            items.append({"filename": path.name, "name": name, "bundle": self.files.pack(files, path.parent)})
        result = self.rpc("export", {"items": items, "folder": folder_id, "library_key": ctx["library_key"], "tags": list(tags or []), "annotation": annotation})
        self.last_export_library_key = ctx["library_key"]
        self.last_export_excludes = result["excludes"]
        self.last_export_items = [None] * len(items)
        return result.get("result")
