import asyncio

from .core import EagleError, parse_settings
from .runtime import client_for, lock_catalog, prepare_catalog, snapshot_previews, media_file, model_resource


def register_routes():
    from aiohttp import web
    from server import PromptServer
    routes = PromptServer.instance.routes

    @routes.get("/eagle_assets/media/{media_id}")
    async def media(request):
        try:
            path, mime = media_file(request.match_info["media_id"])
            return web.FileResponse(path, headers={"Content-Type": mime, "Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff"})
        except EagleError:
            return web.json_response({"ok": False, "error": "媒体预览已过期或不可读取，请刷新预览。"}, status=404)

    @routes.get("/eagle_assets/model/{model_id}/{resource:.*}")
    async def model(request):
        try:
            path, mime = model_resource(request.match_info["model_id"], request.match_info["resource"])
            return web.FileResponse(path, headers={"Content-Type": mime, "Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff"})
        except EagleError:
            return web.json_response({"ok": False, "error": "模型预览资源不可读取。"}, status=404)

    @routes.get("/eagle_assets/vendor/{filename}")
    async def vendor(request):
        from pathlib import Path
        allowed = {"three.module.mjs", "three.core.mjs", "OrbitControls.mjs", "GLTFLoader.mjs", "OBJLoader.mjs",
                   "STLLoader.mjs", "MTLLoader.mjs", "BufferGeometryUtils.mjs", "SkeletonUtils.mjs", "meshopt_decoder.module.mjs"}
        filename = request.match_info["filename"]
        path = Path(__file__).parent / "web" / "vendor" / "three" / filename
        if filename not in allowed or not path.is_file():
            return web.json_response({"ok": False, "error": "预览模块不存在。"}, status=404)
        return web.FileResponse(path, headers={"Content-Type": "application/javascript", "Cache-Control": "public, max-age=86400"})

    async def handle(request, operation):
        try:
            body = await request.json()
            if not isinstance(body, dict):
                raise EagleError("请求格式无效。")
            result = await asyncio.to_thread(operation, body)
            return web.json_response({"ok": True, **result})
        except EagleError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)
        except Exception:
            # Never expose token-bearing URLs or local filesystem paths in an unexpected traceback.
            return web.json_response({"ok": False, "error": "Eagle 操作失败，请检查 Eagle 服务与本地文件权限。"}, status=500)

    @routes.post("/eagle_assets/connect")
    async def connect(request):
        def operation(body):
            settings = parse_settings(body["settings"])
            ctx = client_for(settings).context()
            return {key: ctx[key] for key in ("library_key", "library_name", "folders")}
        return await handle(request, operation)

    @routes.post("/eagle_assets/catalog")
    async def catalog(request):
        return await handle(request, lambda body: prepare_catalog(parse_settings(body["settings"])))

    @routes.post("/eagle_assets/lock")
    async def lock(request):
        return await handle(request, lambda body: {"locked": lock_catalog(body["catalog_id"], parse_settings(body["settings"]), body["selected_ids"])})

    @routes.post("/eagle_assets/snapshot")
    async def snapshot(request):
        return await handle(request, lambda body: {"items": snapshot_previews(body["snapshot_id"])})
