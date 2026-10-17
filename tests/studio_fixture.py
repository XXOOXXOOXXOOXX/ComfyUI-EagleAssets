"""Actual aiohttp plugin routes, fake local Eagle/Ollama, and no real cloud calls."""
import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import tempfile

WORKSPACE = Path(__file__).parents[2]
sys.path.insert(0, str(WORKSPACE / ".test-deps"))
from aiohttp import web
from fixture import Fixture, PLUGIN


def load_studio():
    root = WORKSPACE / "ComfyUI-OllamaStudio"
    name = "ollama_studio_fixture"
    spec = importlib.util.spec_from_file_location(name, root / "__init__.py", submodule_search_locations=[str(root)])
    module = importlib.util.module_from_spec(spec); sys.modules[name] = module; spec.loader.exec_module(module)
    return module


async def main():
    with tempfile.TemporaryDirectory(prefix="eagle-ollama-studio-test-") as root:
        fixture = Fixture(root, media=True, native_web=True)
        studio = load_studio()
        app = web.Application(client_max_size=1024 ** 3)
        app.router.add_routes(fixture.handlers)

        async def config(request):
            return web.json_response({"mock_host": fixture.host, "files": {
                "image": str(fixture.library / "images" / "media_image.info" / "picture.png"),
                "video": str(fixture.library / "images" / "media_video.info" / "clip.mp4"),
                "audio": str(fixture.library / "images" / "media_audio.info" / "sound.wav")}})

        async def stats(request):
            return web.json_response({"counts": dict(fixture.counts), "ollama_calls": fixture.ollama_calls,
                                      "exports": len(fixture.exports)})

        async def run_media(request):
            body = await request.json()
            result = fixture.plugin.NODE_CLASS_MAPPINGS["EagleMediaImport"]().load(body["settings"], body.get("query"))
            return web.json_response({"ui": result["ui"], "ids": [[asset.metadata["id"] for asset in bundle.items] for bundle in result["result"][:4]]})

        app.router.add_get("/tests/studio-config", config)
        app.router.add_get("/tests/studio-stats", stats)
        app.router.add_post("/tests/run-media-import", run_media)

        async def script(request):
            if request.match_info["filename"] == "app.js":
                source = """export const app={extensions:[],registerExtension(e){this.extensions.push(e)},graph:{links:{},change(){},getNodeById(id){return globalThis.testNodes?.[id]}},canvas:{canvas:null},ui:{settings:{addSetting(){},getSettingValue(key,fallback){return fallback}}},extensionManager:{registerSidebarTab(){},sidebarTab:{registerSidebarTab(){}}}};"""
            elif request.match_info["filename"] == "api.js":
                source = """export const api={apiURL:path=>path,fetchApi:(path,options)=>fetch(path,options),addEventListener(){},removeEventListener(){}};"""
            else:
                raise web.HTTPNotFound()
            return web.Response(text=source, content_type="application/javascript")
        app.router.add_get("/scripts/{filename}", script)

        async def static(request):
            group = request.match_info["group"]
            base = PLUGIN if group == "eagle" else WORKSPACE / "ComfyUI-OllamaStudio"
            path = (base / "web" / request.match_info["filename"]).resolve()
            if not path.is_relative_to((base / "web").resolve()) or not path.is_file(): raise web.HTTPNotFound()
            return web.FileResponse(path, headers={"Content-Type": "application/javascript" if path.suffix in {".js", ".mjs"} else "text/css"})
        app.router.add_get("/{group:eagle|studio}/web/{filename:.*}", static)

        async def harness(request):
            return web.FileResponse(Path(__file__).parent / "studio_ui_harness.html", headers={"Content-Type": "text/html"})
        app.router.add_get("/tests/studio_ui_harness.html", harness)
        app.router.add_get("/tests/workflow_switch_harness.html", lambda request: web.FileResponse(Path(__file__).parent / "workflow_switch_harness.html", headers={"Content-Type": "text/html"}))

        async def view(request):
            import folder_paths
            kind = request.query.get("type", "temp")
            base = Path(folder_paths.get_directory_by_type(kind)).resolve()
            path = (base / request.query.get("subfolder", "") / request.query.get("filename", "")).resolve()
            if not path.is_relative_to(base) or not path.is_file(): raise web.HTTPNotFound()
            return web.FileResponse(path)
        app.router.add_get("/view", view)
        runner = web.AppRunner(app); await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0); await site.start()
        host = "http://127.0.0.1:" + str(site._server.sockets[0].getsockname()[1])
        print(json.dumps({"host": host, "mock_host": fixture.host}), flush=True)
        try:
            await asyncio.to_thread(sys.stdin.readline)
        finally:
            await runner.cleanup(); fixture.close()


if __name__ == "__main__": asyncio.run(main())
