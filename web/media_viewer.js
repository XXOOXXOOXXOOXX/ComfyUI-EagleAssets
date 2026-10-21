import { canPreviewModel, createModelPreview } from "./model_preview.js";
const KEY = "eagle-assets.media-viewer.v1";
let shared;
const el = (tag, className = "", text = "") => { const value = document.createElement(tag); value.className = className; value.textContent = text; return value; };
const action = (label, text, callback) => { const value = el("button", "", text); value.type = "button"; value.title = value.ariaLabel = label; value.addEventListener("click", callback); return value; };
const bounded = (value, min, max) => Math.max(min, Math.min(max, Number(value) || min));
function style() {
    if (document.getElementById("eagle-media-viewer-style")) return;
    const sheet = el("style"); sheet.id = "eagle-media-viewer-style";
    sheet.textContent = `.eam-viewer{box-sizing:border-box;position:fixed;z-index:3200;display:flex;flex-direction:column;background:#202126;color:#eceef3;border:1px solid #60636e;border-radius:13px;box-shadow:0 16px 55px #0009;font:12px/1.45 system-ui;overflow:hidden;isolation:isolate}.eam-viewer *{box-sizing:border-box}.eam-viewer button,.eam-viewer input,.eam-viewer select{font:inherit;color:inherit;background:#30323a;border:1px solid #5b606b;border-radius:5px;padding:4px 6px;min-width:0}.eam-viewer button{cursor:pointer}.eam-viewer button:disabled{opacity:.45;cursor:default}.eam-viewer [hidden]{display:none!important}.eam-head{display:flex;flex-wrap:wrap;align-items:center;gap:5px;padding:8px;background:#292b31;touch-action:none;cursor:move;flex:none}.eam-head label{display:flex;align-items:center;gap:3px}.eam-head input{width:58px}.eam-title{font-weight:600;margin-right:auto}.eam-main{display:grid;grid-template-columns:minmax(0,1fr) 180px;min-height:0;flex:1}.eam-stage{position:relative;overflow:hidden;min-width:0;min-height:100px;background:#111318;touch-action:none}.eam-transform{position:absolute;top:50%;left:50%;width:100%;height:100%;object-fit:contain;transform-origin:center;user-select:none;-webkit-user-drag:none}.eam-model{position:absolute;inset:0;overflow:hidden}.eam-model canvas{display:block;width:100%;height:100%;touch-action:none}.eam-file{position:absolute;inset:0;display:grid;place-content:center;text-align:center;color:#b5c2d8;overflow-wrap:anywhere;padding:25px;font-size:24px}.eam-tools{position:absolute;bottom:8px;left:8px;right:8px;display:flex;flex-wrap:wrap;align-items:center;gap:5px;padding:6px;border-radius:7px;background:#22252bdc;z-index:2}.eam-tools button,.eam-tools select{background:#343944b3;padding:3px 6px}.eam-tools a{color:#beddf8;text-decoration:none;padding:3px}.eam-seek{flex:1;min-width:55px!important;width:60px;padding:0!important}.eam-time{font-size:10px}.eam-aside{padding:10px;overflow:auto;background:#24262d;min-width:0}.eam-aside label{display:block;margin:11px 0}.eam-aside input{width:100%;margin-top:5px}.eam-aside textarea{width:100%;min-height:85px;background:#181b21;color:#d8dfec;border:1px solid #4d5563;border-radius:5px;padding:7px;resize:vertical;font:inherit}.eam-status{font-size:11px;color:#b4c5db;overflow-wrap:anywhere;margin:7px 0}.eam-resize{position:absolute;right:0;bottom:0;padding:3px;cursor:nwse-resize;touch-action:none;z-index:3}.eam-viewer button[data-locked=true]{color:#9ae9cd;border-color:#72b59d;background:#24483b}.eam-stage:fullscreen{width:100vw;height:100vh}.eam-note{font-size:11px;color:#9ba9bd;margin:7px 0}`;
    document.head.append(sheet);
    sheet.textContent += `.eam-volume{position:relative;display:flex;align-items:center}.eam-volume-panel{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);padding:12px 9px 10px;background:#252931ed;border:1px solid #606976;border-radius:9px;display:none;flex-direction:column;align-items:center;gap:5px;box-shadow:0 4px 16px #0006}.eam-volume:hover .eam-volume-panel,.eam-volume:focus-within .eam-volume-panel{display:flex}.eam-viewer .eam-volume-slider{writing-mode:vertical-lr;direction:rtl;appearance:auto;width:22px;height:125px;padding:0;accent-color:#50a9f4;cursor:pointer}.eam-volume-value{font-size:10px;min-width:32px;text-align:center}.eam-volume button{font-size:17px;line-height:20px;min-width:32px}`;
}
export class MediaViewer {
    constructor() {
        style(); this.prefs = { size_locked: false, position_locked: false, sensitivity: 1 };
        try { Object.assign(this.prefs, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch { /* reset corrupt preferences */ }
        this.root = el("section", "eam-viewer"); this.root.setAttribute("role", "dialog"); this.root.ariaLabel = "Eagle 素材放大查看";
        this.head = el("header", "eam-head"); this.head.append(el("span", "eam-title", "素材查看")); this.fields = {};
        for (const [key, label] of [["width", "宽"], ["height", "高"], ["x", "X"], ["y", "Y"]]) {
            const input = el("input"); input.type = "number"; input.ariaLabel = "预览浮窗" + label; input.step = "1";
            input.addEventListener("change", () => { this.rect[key] = Number(input.value); this.layout(); this.save(); });
            const wrap = el("label", "", label); wrap.append(input); this.head.append(wrap); this.fields[key] = input;
            if (key === "height" || key === "y") {
                const option = key === "height" ? "size_locked" : "position_locked", title = key === "height" ? "锁定浮窗尺寸" : "锁定浮窗位置";
                const lock = action(title, "♧", () => { this.prefs[option] = !this.prefs[option]; this.layout(); this.save(); }); lock.dataset.lock = option; this.head.append(lock);
            }
        }
        this.head.append(action("关闭素材预览", "×", () => this.close()));
        this.stage = el("div", "eam-stage"); this.tools = el("div", "eam-tools"); this.aside = el("aside", "eam-aside");
        const main = el("div", "eam-main"); main.append(this.stage, this.aside); this.root.append(this.head, main);
        this.aside.append(action("素材复位", "素材复位", () => this.reset()));
        const sensitivity = el("label", "", "鼠标滚轮灵敏度"); this.sensitivity = el("input"); this.sensitivity.type = "number"; this.sensitivity.min = ".1"; this.sensitivity.max = "5"; this.sensitivity.step = ".1"; this.sensitivity.ariaLabel = "鼠标滚轮灵敏度";
        this.sensitivity.value = bounded(this.prefs.sensitivity, .1, 5); this.sensitivity.addEventListener("change", () => { this.prefs.sensitivity = bounded(this.sensitivity.value, .1, 5); this.sensitivity.value = this.prefs.sensitivity; this.model?.setInteraction({ zoomSpeed: this.prefs.sensitivity, panWithLeft: true }); this.save(); }); sensitivity.append(this.sensitivity);
        const name = el("label", "", "素材名称"); this.name = el("input"); this.name.ariaLabel = "素材名称"; this.name.readOnly = true; name.append(this.name);
        this.rename = action("修改 Eagle 素材名称", "修改名称", () => this.renameItem());
        this.annotation = el("textarea"); this.annotation.readOnly = true; this.annotation.ariaLabel = "Eagle 注释";
        this.status = el("div", "eam-status"); this.status.setAttribute("role", "status");
        this.aside.append(sensitivity, name, this.rename, el("div", "eam-note", "Eagle 注释"), this.annotation, this.status, el("div", "eam-note", "展示区：滚轮缩放，左键拖动。3D 可用右键旋转。"));
        this.resizer = el("div", "eam-resize", "◢"); this.resizer.ariaLabel = "调整素材浮窗尺寸"; this.root.append(this.resizer);
        for (const event of ["pointerdown", "keydown", "wheel"]) this.root.addEventListener(event, event => event.stopPropagation());
        this.drag(this.head, "position"); this.drag(this.resizer, "size");
        this.stage.addEventListener("wheel", event => { if (this.model || event.target.closest(".eam-tools")) return; event.preventDefault(); const old = this.zoom, next = bounded(old * Math.exp(-event.deltaY * .0015 * this.prefs.sensitivity), .05, 30), bounds = this.stage.getBoundingClientRect(), x = event.clientX - bounds.x - bounds.width / 2, y = event.clientY - bounds.y - bounds.height / 2; this.pan.x = x - (x - this.pan.x) * next / old; this.pan.y = y - (y - this.pan.y) * next / old; this.zoom = next; this.transform(); }, { passive: false });
        this.stage.addEventListener("pointerdown", event => {
            if (event.button !== 0 || this.model || event.target.closest(".eam-tools")) return; event.preventDefault();
            const x = event.clientX, y = event.clientY;
            const initial = { ...this.pan }; this.stage.setPointerCapture(event.pointerId);
            const move = current => { this.pan = { x: initial.x + current.clientX - x, y: initial.y + current.clientY - y }; this.transform(); };
            const end = () => { this.stage.removeEventListener("pointermove", move); this.stage.removeEventListener("pointerup", end); this.stage.removeEventListener("pointercancel", end); };
            this.stage.addEventListener("pointermove", move); this.stage.addEventListener("pointerup", end); this.stage.addEventListener("pointercancel", end);
        });
        this.onResize = () => this.layout(); this.onKey = event => { if (event.key === "Escape" && !document.fullscreenElement) this.close(); };
    }
    save() { Object.assign(this.prefs, this.rect); try { localStorage.setItem(KEY, JSON.stringify(this.prefs)); } catch { /* preview remains usable */ } }
    layout() {
        if (!this.rect) return;
        this.rect.width = bounded(this.rect.width, Math.min(480, innerWidth - 16), innerWidth - 16); this.rect.height = bounded(this.rect.height, Math.min(300, innerHeight - 16), innerHeight - 16);
        this.rect.x = bounded(this.rect.x, 0, innerWidth - this.rect.width); this.rect.y = bounded(this.rect.y, 0, innerHeight - this.rect.height);
        Object.assign(this.root.style, { width: this.rect.width + "px", height: this.rect.height + "px", left: this.rect.x + "px", top: this.rect.y + "px" });
        for (const [key, input] of Object.entries(this.fields)) { input.value = Math.round(this.rect[key]); input.disabled = key === "width" || key === "height" ? this.prefs.size_locked : this.prefs.position_locked; }
        for (const lock of this.head.querySelectorAll("[data-lock]")) { const value = !!this.prefs[lock.dataset.lock]; lock.dataset.locked = String(value); lock.textContent = value ? "🔒" : "🔓"; lock.setAttribute("aria-pressed", String(value)); }
        this.resizer.hidden = !!this.prefs.size_locked;
    }
    drag(handle, kind) {
        handle.addEventListener("pointerdown", event => {
            if (event.button !== 0 || event.target.closest("button,input,label") || (kind === "position" ? this.prefs.position_locked : this.prefs.size_locked)) return;
            event.preventDefault(); handle.setPointerCapture(event.pointerId); const start = { ...this.rect }, x = event.clientX, y = event.clientY;
            const move = current => { if (kind === "position") { this.rect.x = start.x + current.clientX - x; this.rect.y = start.y + current.clientY - y; } else { this.rect.width = start.width + current.clientX - x; this.rect.height = start.height + current.clientY - y; } this.layout(); };
            const end = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", end); handle.removeEventListener("pointercancel", end); this.save(); };
            handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", end); handle.addEventListener("pointercancel", end);
        });
    }
    async open(item, options) {
        if (!this.root.isConnected) {
            const width = this.prefs.size_locked ? this.prefs.width : innerWidth / 3, height = this.prefs.size_locked ? this.prefs.height : innerHeight / 2;
            this.rect = { width, height, x: this.prefs.position_locked ? this.prefs.x : (innerWidth - width) / 2, y: this.prefs.position_locked ? this.prefs.y : (innerHeight - height) / 2 };
            document.body.append(this.root); addEventListener("resize", this.onResize); addEventListener("keydown", this.onKey);
        }
        this.cleanup(); const generation = this.generation = (this.generation || 0) + 1;
        this.item = item; this.options = options; this.name.value = item.name || item.filename || "素材"; this.name.readOnly = true; this.rename.textContent = "修改名称"; this.rename.disabled = !options.rename || !!options.info;
        this.annotation.value = item.annotation || ""; this.status.textContent = options.rename ? "" : "此预览未关联 Eagle 素材，名称仅供查看。";
        this.layout(); this.reset(); this.renderMedia();
        if (options.info) try { const result = await options.info(); if (generation !== this.generation || !this.root.isConnected) return; this.item = { ...this.item, ...result }; this.name.value = result.name || this.name.value; this.annotation.value = result.annotation || ""; this.rename.disabled = !options.rename; } catch (error) { if (generation === this.generation) this.status.textContent = error.message; }
    }
    async renameItem() {
        if (!this.options.rename) return;
        if (this.name.readOnly) { this.name.readOnly = false; this.rename.textContent = "保存名称"; this.name.focus(); this.name.select(); return; }
        this.rename.disabled = true; const generation = this.generation;
        try { const item = await this.options.rename(this.name.value); if (generation !== this.generation || !this.root.isConnected) return; this.item = { ...this.item, ...item }; this.name.value = item.name; this.name.readOnly = true; this.rename.textContent = "修改名称"; this.status.textContent = "已同步修改 Eagle 素材名称"; }
        catch (error) { if (generation === this.generation) this.status.textContent = error.message; }
        finally { if (generation === this.generation) this.rename.disabled = false; }
    }
    reset() { this.zoom = 1; this.pan = { x: 0, y: 0 }; this.model?.reset(); this.transform(); }
    transform() { if (this.visual) this.visual.style.transform = `translate(-50%,-50%) translate(${this.pan.x}px,${this.pan.y}px) scale(${this.zoom})`; }
    renderMedia() {
        const item = this.item, type = item.media_type || "image", url = this.options.url(item), ext = String(item.ext || item.filename?.split(".").pop() || "").toLowerCase();
        this.stage.replaceChildren(); this.tools.replaceChildren(); this.visual = null; this.model = null;
        if (type === "model" && canPreviewModel(ext)) {
            const viewport = el("div", "eam-model"); this.stage.append(viewport);
            const viewer = this.model = createModelPreview(viewport, { url: this.options.modelURL?.(item) || url, ext, apiURL: this.options.apiURL });
            viewer.ready.then(() => viewer.setInteraction({ zoomSpeed: this.prefs.sensitivity, panWithLeft: true })).catch(error => { if (this.model === viewer) this.status.textContent = "模型预览不可用：" + error.message; });
        } else if (type === "image" || type === "video") {
            this.visual = el(type === "image" ? "img" : "video", "eam-transform"); this.visual.src = url; this.visual.draggable = false;
            if (type === "image") Object.assign(this.visual.style, { backgroundColor: "#eee", backgroundImage: "conic-gradient(#aaa 25%,#eee 0 50%,#aaa 0 75%,#eee 0)", backgroundSize: "16px 16px" });
            if (type === "video") { this.media = this.visual; this.media.preload = "metadata"; }
            this.stage.append(this.visual); this.transform();
        } else {
            this.stage.append(el("div", "eam-file", type === "audio" ? "♫" : `${ext.toUpperCase()} 模型文件`));
            if (type === "audio") { this.media = el("audio"); this.media.src = url; this.media.preload = "metadata"; this.stage.append(this.media); }
        }
        if (this.media) {
            const media = this.media, play = action("播放或暂停", "播放", async () => { try { if (media.paused) await media.play(); else media.pause(); } catch { this.status.textContent = "浏览器无法播放此格式，可下载后查看。"; } });
            media.addEventListener("play", () => play.textContent = "暂停"); media.addEventListener("pause", () => play.textContent = "播放");
            const seek = el("input", "eam-seek"); seek.type = "range"; seek.min = 0; seek.max = 1000; seek.value = 0; seek.ariaLabel = "播放进度"; seek.addEventListener("input", () => { if (Number.isFinite(media.duration)) media.currentTime = media.duration * seek.value / 1000; });
            const clock = el("span", "eam-time", "0:00"); media.addEventListener("timeupdate", () => { seek.value = media.duration ? media.currentTime / media.duration * 1000 : 0; clock.textContent = `${Math.floor(media.currentTime / 60)}:${String(Math.floor(media.currentTime % 60)).padStart(2,"0")}`; });
            media.volume = Number.isFinite(this.prefs.volume) ? Math.max(0, Math.min(1, this.prefs.volume)) : 1;
            media.muted = !!this.prefs.muted;
            let lastAudible = media.volume || this.prefs.last_volume || .5;
            const volume = el("div", "eam-volume"), volumePanel = el("div", "eam-volume-panel"), slider = el("input", "eam-volume-slider"), percentage = el("span", "eam-volume-value");
            slider.type = "range"; slider.min = 0; slider.max = 100; slider.step = 1; slider.ariaLabel = "素材音量"; slider.setAttribute("aria-orientation", "vertical");
            const mute = action("静音或取消静音", "🔊", () => {
                if (media.muted || media.volume === 0) { if (media.volume === 0) media.volume = lastAudible; media.muted = false; }
                else { lastAudible = media.volume; media.muted = true; }
            });
            const updateVolume = () => {
                const silent = media.muted || media.volume === 0, value = Math.round(media.volume * 100);
                slider.value = silent ? 0 : value; percentage.textContent = (silent ? 0 : value) + "%";
                mute.textContent = silent ? "🔇" : value < 50 ? "🔉" : "🔊"; mute.setAttribute("aria-pressed", String(silent));
                mute.title = silent ? "点击恢复声音；悬停调节音量" : `音量 ${value}%；点击静音，悬停调节音量`;
                this.prefs.volume = media.volume; this.prefs.muted = media.muted; if (media.volume > 0) this.prefs.last_volume = media.volume; this.save();
            };
            slider.addEventListener("input", () => { media.volume = Number(slider.value) / 100; media.muted = media.volume === 0; if (media.volume > 0) lastAudible = media.volume; updateVolume(); });
            media.addEventListener("volumechange", updateVolume); updateVolume(); volumePanel.append(slider, percentage); volume.append(volumePanel, mute);
            const speed = el("select"); speed.ariaLabel = "播放速度"; for (const rate of [.25,.5,1,1.5,2,3,4]) { const option = el("option", "", rate + "×"); option.value = rate; speed.append(option); } speed.value = 1; speed.addEventListener("change", () => media.playbackRate = Number(speed.value));
            this.tools.append(play, seek, clock, volume, speed);
            if (type === "video" && document.pictureInPictureEnabled && media.requestPictureInPicture) this.tools.append(action("画中画", "画中画", async () => { try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await media.requestPictureInPicture(); } catch { this.status.textContent = "视频加载后才能进入画中画。"; } }));
        }
        this.tools.append(action("全屏查看", "全屏", async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await this.stage.requestFullscreen(); } catch { this.status.textContent = "当前浏览器不支持全屏。"; } }));
        const download = el("a", "", "下载"); download.href = url; download.download = item.filename || ((item.name || "素材") + (ext ? "." + ext : "")); this.tools.append(download); this.stage.append(this.tools);
    }
    cleanup() { this.model?.dispose(); this.model = null; if (this.media) { this.media.pause(); this.media.removeAttribute("src"); this.media.load(); this.media = null; } }
    close() { this.save(); ++this.generation; this.cleanup(); this.root.remove(); removeEventListener("resize", this.onResize); removeEventListener("keydown", this.onKey); }
}
export function openMediaViewer(item, options) { shared ||= new MediaViewer(); return shared.open(item, options); }
