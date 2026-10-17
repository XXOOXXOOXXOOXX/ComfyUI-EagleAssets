import { canSearch, catalogKey, validCatalog, itemType, MEDIA_TYPES, matchItems, outputSelection, parseState, sortItems, SORT_MODES,
    makePreviewCache, readPreviewCache } from "./model.js";
import { canPreviewModel, createModelPreview } from "./model_preview.js";
import { openMediaViewer } from "./media_viewer.js";
globalThis.EagleAssetsModelPreview = { canPreviewModel, createModelPreview };
const connectedEditors = new Set();
addEventListener("eagle-assets-item-updated", event => {
    const item = event.detail;
    for (const editor of connectedEditors) {
        if (editor.state.library_key && item.library_key && editor.state.library_key !== item.library_key) continue;
        let changed = false;
        for (const values of [editor.items, editor.lockedItems, editor.previews, editor.executionItems]) for (const original of values || []) {
            if ((original.eagle_id || original.id) === item.id) { Object.assign(original, { name: item.name, annotation: item.annotation }); changed = true; }
        }
        if (changed) { editor.cachePreview?.(); editor.renderMedia?.(); editor.render(); editor.changed?.(); }
    }
});

function attachPreview(editor) {
    let firstClick, openedAt = 0;
    const find = target => {
        const card = target.closest?.(".ea-card,.ea-export-card");
        return card?.dataset.id ? editor.items?.find(item => item.id === card.dataset.id) : card?.dataset.previewIndex != null ? editor.previews?.[Number(card.dataset.previewIndex)] : null;
    };
    const open = item => {
        const exported = !!editor.previews?.includes(item); let id = exported ? item.eagle_id : item.id;
        const settings = () => JSON.stringify({ ...editor.state, library_key: item.library_key || editor.state.library_key, folder_id: item.eagle_folder_id || editor.state.folder_id });
        const info = async () => {
            const result = id ? await editor.request("item_info", { settings: settings(), item_id: id }) : await editor.request("resolve_export", { settings: settings(), name: item.name, ext: item.eagle_ext || item.ext, excluded_ids: item.eagle_exclude_ids });
            id = result.item.id; if (exported) item.eagle_id = id;
            return result.item;
        };
        editor.root.querySelectorAll("audio,video").forEach(player => player.pause());
        openMediaViewer(item, {
            apiURL: editor.mediaURL,
            url: value => value.media_url ? editor.mediaURL(value.media_url) : value.filename ? editor.imageURL({ filename: value.filename, subfolder: value.subfolder || "", type: value.type || "temp" }) : editor.imageURL(value.preview),
            modelURL: value => editor.mediaURL(value.model_url || value.preview_url || value.media_url),
            info: id || item.eagle_saved ? info : null,
            rename: id || item.eagle_saved ? async name => { if (!id) await info(); const result = await editor.request("rename", { settings: settings(), item_id: id, name }); dispatchEvent(new CustomEvent("eagle-assets-item-updated", { detail: result.item })); return result.item; } : null,
        });
        openedAt = performance.now();
    };
    editor.root.addEventListener("click", event => {
        const item = find(event.target); if (!item) return;
        if (event.detail === 1) firstClick = { item: item.id || item.filename, state: structuredClone(editor.state) };
        if (event.detail > 1) {
            event.preventDefault(); event.stopImmediatePropagation();
            if (firstClick?.item === (item.id || item.filename) && editor.items) { editor.state = firstClick.state; editor.persist(); editor.render(); }
            open(item); firstClick = null;
        }
    }, true);
    editor.root.addEventListener("dblclick", event => { const item = find(event.target); if (!item) return; event.preventDefault(); event.stopPropagation(); if (performance.now() - openedAt > 200) open(item); }, true);
}

const STYLE = `
.ea-panel{box-sizing:border-box;width:100%;padding:12px;background:#20252e;border:1px solid #445061;border-radius:10px;color:#e9eef6;font:13px/1.45 system-ui,sans-serif;overflow:hidden}.ea-panel *{box-sizing:border-box}
.ea-row{display:flex;align-items:center;flex-wrap:wrap;gap:7px;margin-bottom:9px}.ea-panel input,.ea-panel select,.ea-panel textarea,.ea-panel button{font:inherit;color:inherit;background:#303b4b;border:1px solid #53647b;border-radius:6px;padding:6px 8px;min-width:0}
.ea-panel button{cursor:pointer}.ea-panel button:hover:not(:disabled){background:#40536d}.ea-panel :disabled{opacity:.48;cursor:default}.ea-panel label{display:flex;align-items:center;gap:6px}.ea-grow{flex:1}.ea-panel input[type=number]{width:76px}.ea-panel input[type=checkbox]{accent-color:#67cda6}.ea-host{width:100%}.ea-token{width:125px}.ea-panel select.ea-folder{width:100%}.ea-panel textarea{width:100%;height:65px;resize:vertical}.ea-panel .ea-primary{background:#237457;border-color:#3aaa7e}
.ea-status{padding:5px 8px;background:#303b4b;border-radius:5px;overflow-wrap:anywhere}.ea-status[data-locked=true]{background:#205b49;color:#adf4d3}.ea-note{font-size:12px;color:#a8b4c6;margin:7px 0}.ea-error{color:#ffb5a8;min-height:18px;margin-top:7px;overflow-wrap:anywhere}
.ea-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(105px,1fr));gap:8px;overflow:auto;max-height:330px;min-height:125px;padding:5px 2px}.ea-card{position:relative;text-align:left;padding:5px!important;background:#293341!important;min-width:0;display:block}.ea-card[data-selected=true]{border:2px solid #64d8a5!important;background:#254438!important}.ea-card img{display:block;width:100%;height:90px;object-fit:contain;background:#161c24;border-radius:4px}.ea-card .ea-name{font-size:12px;overflow-wrap:anywhere;margin-top:4px}.ea-card .ea-dims{font-size:11px;color:#a8b9d0}.ea-badge{position:absolute;top:6px;left:6px;background:#18754f;border:1px solid #8af1c2;border-radius:5px;padding:1px 6px;color:#fff;font-weight:600}.ea-empty{grid-column:1/-1;color:#9eafc6;text-align:center;padding:32px 12px}
.ea-card:disabled{opacity:1;cursor:default}.ea-toggle[data-on=true]{background:#237457;border-color:#5bddaa}.ea-toggle[data-on=false]{background:#394354;color:#aebed2}
.ea-card video{display:block;width:100%;height:90px;object-fit:contain;background:#161c24;border-radius:4px}.ea-card audio{display:block;width:100%;height:32px;margin:29px 0}.ea-card .ea-file{display:flex;align-items:center;justify-content:center;height:90px;background:#161c24;color:#b6c9df;border-radius:4px;font-size:25px}.ea-card[role=button]{cursor:pointer;border:1px solid #53647b;border-radius:6px}.ea-card[aria-disabled=true]{cursor:default}.ea-kind{position:absolute;right:7px;top:7px;padding:1px 4px;background:#1c2634c9;border-radius:3px;font-size:10px;pointer-events:none}.ea-paths{max-height:132px;overflow:auto;margin-bottom:9px}.ea-paths .ea-row{margin-bottom:6px}.ea-folder-number{width:20px;text-align:center;color:#a8b9d0}.ea-types{gap:5px}.ea-types button{flex:1;padding:5px}.ea-media-options{font-size:12px;margin-bottom:9px;color:#b8c6d9}.ea-media-options summary{cursor:pointer}.ea-media-options .ea-row{margin:7px 0}.ea-media-options input[type=number]{width:65px}.ea-media-options .ea-note{margin:4px 0}
.ea-panel .ea-annotation{display:block;margin-bottom:9px}.ea-annotation textarea{display:block;margin-top:5px}
.ea-paths{max-height:200px}
.ea-export-media{display:grid;gap:10px;max-height:420px;overflow:auto;margin-top:10px}.ea-export-card{padding:9px;border:1px solid #4d627b;border-radius:7px;background:#19232f}.ea-export-card video{width:100%;max-height:280px;display:block;background:#111821;border-radius:5px}.ea-export-card audio{width:100%;display:block;margin:8px 0}.ea-export-name{font-size:12px;overflow-wrap:anywhere;margin-bottom:7px}.ea-export-links{display:flex;gap:9px;align-items:center;justify-content:space-between;margin-top:7px;font-size:12px}.ea-export-links a{color:#97d5f4}.ea-export-links button{padding:3px 7px;font-size:12px}.ea-model-viewer{width:100%;height:280px;overflow:hidden;background:#17202c;border-radius:5px;position:relative}.ea-model-viewer canvas{display:block;width:100%;height:100%;touch-action:none}.ea-model-status{font-size:12px;color:#b7cadf;overflow-wrap:anywhere;margin-top:7px}.ea-export-file{padding:20px;background:#17202c;text-align:center;color:#afc4dd}
.ea-panel.ea-node-panel{display:flex;flex-direction:column;height:100%;min-height:0}.ea-node-panel> :not(.ea-grid):not(.ea-export-media){flex-shrink:0}.ea-node-panel>.ea-grid,.ea-node-panel>.ea-export-media{flex:1 1 0;min-height:125px;max-height:none}.ea-node-panel>.ea-grid{align-content:start}.ea-node-panel>.ea-export-media{grid-auto-rows:minmax(min-content,1fr);align-content:stretch}.ea-node-panel .ea-export-card{display:flex;flex-direction:column;min-height:0}.ea-node-panel .ea-export-card>img,.ea-node-panel .ea-export-card>video{flex:1 0 125px;height:125px;min-height:125px;max-height:none!important;object-fit:contain}.ea-node-panel .ea-model-viewer{flex:1 0 240px;min-height:240px;height:240px}.ea-node-panel .ea-export-name,.ea-node-panel .ea-export-links,.ea-node-panel .ea-model-status{flex-shrink:0}
`;
function installStyle() {
    if (document.getElementById("eagle-assets-style")) return;
    const style = document.createElement("style"); style.id = "eagle-assets-style"; style.textContent = STYLE; document.head.append(style);
}
function createRoot(html) {
    installStyle(); const root = document.createElement("div"); root.className = "ea-panel"; root.innerHTML = html;
    for (const name of ["pointerdown", "keydown", "wheel"]) root.addEventListener(name, e => e.stopPropagation(), { passive: name === "wheel" });
    return root;
}
function card(item, imageURL, index, selected, clicked, mediaURL = url => url) {
    const type = itemType(item), interactive = type === "video" || type === "audio";
    const element = document.createElement("div"); element.setAttribute("role", "button"); element.tabIndex = 0;
    element.className = "ea-card";
    element.dataset.id = item.id; element.dataset.selected = String(selected); element.title = item.name;
    let visual;
    if (interactive && item.media_url) {
        visual = document.createElement(type); visual.controls = true; visual.preload = "none"; visual.src = mediaURL(item.media_url);
        if (type === "video" && item.preview) visual.poster = imageURL(item.preview);
        // Playback controls are independent from selection and graph dragging.
        for (const event of ["click", "pointerdown", "keydown"]) visual.addEventListener(event, e => e.stopPropagation());
    } else if (item.preview) {
        visual = document.createElement("img"); visual.loading = "lazy"; visual.alt = item.name; visual.src = imageURL(item.preview);
    } else {
        visual = document.createElement("div"); visual.className = "ea-file"; visual.textContent = { image: "图", video: "▶", audio: "♫", model: "3D" }[type];
    }
    const name = document.createElement("div"); name.className = "ea-name"; name.textContent = item.name;
    const dims = document.createElement("div"); dims.className = "ea-dims";
    dims.textContent = [type === "image" || type === "video" ? `${item.width || "?"} × ${item.height || "?"}` : MEDIA_TYPES[type],
        Number(item.duration) > 0 ? `${Number(item.duration).toFixed(1)} 秒` : null, item.ext?.toUpperCase()].filter(Boolean).join(" · ");
    element.append(visual, name, dims);
    if (type !== "image") { const kind = document.createElement("span"); kind.className = "ea-kind"; kind.textContent = MEDIA_TYPES[type]; element.append(kind); }
    if (index > 0) { const badge = document.createElement("span"); badge.className = "ea-badge"; badge.textContent = String(index); element.append(badge); }
    const select = () => { if (!element.disabled && element.getAttribute("aria-disabled") !== "true") clicked(); };
    element.addEventListener("click", select);
    element.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } });
    return element;
}
const CONNECTION_HEADER = `<div class="ea-row"><label class="ea-grow">Eagle 地址 <input class="ea-host ea-grow" aria-label="Eagle 地址"></label></div>
 <div class="ea-row"><label class="ea-grow">Token <input class="ea-token ea-grow" type="password" aria-label="Eagle Token" autocomplete="off" placeholder="无需认证可留空"></label><button data-action="connect">读取 / 刷新目录</button></div>
`;
const CONNECTION_HTML = CONNECTION_HEADER + `<div class="ea-row"><select class="ea-folder" aria-label="Eagle 目录"><option value="">请先读取目录，再选择文件夹</option></select></div>`;
const MEDIA_CONNECTION_HTML = CONNECTION_HEADER + `<div class="ea-row"><label>Eagle 目录数量 <input type="number" aria-label="Eagle 目录数量" min="1" max="32" value="1"></label><span class="ea-note">同时读取多个目录，重复素材合并</span></div><div class="ea-paths"><div class="ea-row"><select class="ea-folder" aria-label="Eagle 目录 1"></select></div></div>`;

class ConnectedEditor {
    initialize(options, html) {
        Object.assign(this, options); this.generation = 0; this.busy = false;
        this.state = parseState(options.raw, { host: "http://localhost:41595", token: "", folder_id: "", limit: 20, preview_loaded: false });
        if (this.media) {
            this.state.folder_count = Math.min(32, Math.max(1, Math.round(Number(this.state.folder_count) || 1)));
            this.state.folder_ids = Array.from({ length: this.state.folder_count }, (_, i) => this.state.folder_ids?.[i] || (i === 0 ? this.state.folder_id : "") || "");
            this.state.types = (this.state.types || []).filter(type => MEDIA_TYPES[type]);
        }
        this.root = createRoot(html); this.host = this.root.querySelector(".ea-host"); this.token = this.root.querySelector(".ea-token"); this.folder = this.root.querySelector(".ea-folder");
        connectedEditors.add(this); attachPreview(this);
        this.host.value = this.state.host || "http://localhost:41595"; this.token.value = this.state.token || "";
        this.host.addEventListener("change", () => this.connectionChanged("host", this.host.value.trim()));
        this.token.addEventListener("change", () => this.connectionChanged("token", this.token.value));
        if (!this.media) this.bindFolder(this.folder, 0);
        this.root.querySelectorAll("button[data-action]").forEach(button => button.addEventListener("click", () => this.action(button.dataset.action)));
        this.populateFolders([]); this.render();
    }
    persist() { this.save(JSON.stringify(this.state)); this.changed?.(); }
    error(message = "") { this.root.querySelector(".ea-error").textContent = message; }
    cancelRequests() {
        this.generation++; this.pendingConnect = null; this.pendingLoad = null; this.busy = false;
    }
    bindFolder(select, index) {
        select.addEventListener("change", () => {
            if (this.media) { this.state.folder_ids[index] = select.value; this.state.folder_labels ||= []; this.state.folder_labels[index] = select.selectedOptions[0]?.textContent || ""; }
            if (index === 0) { this.state.folder_id = select.value; this.state.folder_label = select.selectedOptions[0]?.textContent || ""; }
            this.invalidate?.(); this.persist(); this.render();
        });
    }
    connectionChanged(key, value) {
        this.cancelRequests();
        this.state[key] = value; this.state.library_key = null; this.state.folder_id = "";
        if (this.media) this.state.folder_ids = Array(this.state.folder_count).fill("");
        this.folders = []; this.populateFolders([]); this.invalidate?.(); this.persist(); this.render();
    }
    populateFolders(folders) {
        let selects = [this.folder];
        if (this.media) {
            const container = this.root.querySelector(".ea-paths"); container.replaceChildren(); selects = [];
            for (let index = 0; index < this.state.folder_count; index++) {
                const row = document.createElement("div"); row.className = "ea-row";
                const number = document.createElement("span"); number.className = "ea-folder-number"; number.textContent = String(index + 1);
                const select = document.createElement("select"); select.className = "ea-folder ea-grow"; select.setAttribute("aria-label", `Eagle 目录 ${index + 1}`);
                this.bindFolder(select, index); row.append(number, select); container.append(row); selects.push(select);
            }
            this.folder = selects[0]; this.folderSelects = selects;
        }
        for (const [index, select] of selects.entries()) {
            const previous = (this.media ? this.state.folder_ids[index] : this.state.folder_id) || ""; select.replaceChildren();
            for (const item of [{ id: "", path: "请选择 Eagle 目录" }, ...(folders.length ? [{ id: "__ALL__", path: this.media ? "整个素材库" : "整个素材库（导出至根目录）" }, ...folders] : [])]) {
                const option = document.createElement("option"); option.value = item.id; option.textContent = item.path; select.append(option);
            }
            if (previous && ![...select.options].some(option => option.value === previous)) {
                const option = document.createElement("option"); option.value = previous; option.textContent = ((this.media ? this.state.folder_labels?.[index] : this.state.folder_label) || "已保存目录") + "（待读取）"; select.append(option);
            }
            select.value = previous;
        }
    }
    connect() {
        if (this.destroyed) return Promise.resolve(false);
        const generation = this.generation, connectionKey = JSON.stringify([this.state.host, this.state.token]);
        if (this.pendingConnect?.generation === generation && this.pendingConnect.key === connectionKey) return this.pendingConnect.promise;
        this.busy = true; this.error("正在读取 Eagle 目录…"); this.render();
        const current = () => !this.destroyed && this.generation === generation && connectionKey === JSON.stringify([this.state.host, this.state.token]);
        const promise = (async () => {
            try {
                const result = await this.request("connect", { settings: JSON.stringify(this.state) });
                if (!current()) return false;
                const changedLibrary = this.state.library_key && this.state.library_key !== result.library_key;
                if (changedLibrary) {
                    this.state.folder_id = ""; if (this.media) this.state.folder_ids = Array(this.state.folder_count).fill("");
                    this.invalidate?.({ cancel: false });
                }
                this.state.library_key = result.library_key; this.state.library_name = result.library_name;
                this.folders = result.folders;
                if (this.media) {
                    const validIds = new Set(["", "__ALL__", ...this.folders.map(folder => folder.id)]);
                    const previous = JSON.stringify(this.state.folder_ids);
                    this.state.folder_ids = this.state.folder_ids.map(id => validIds.has(id) ? id : ""); this.state.folder_id = this.state.folder_ids[0];
                    if (previous !== JSON.stringify(this.state.folder_ids)) this.invalidate?.({ cancel: false });
                } else if (this.state.folder_id && this.state.folder_id !== "__ALL__" && !this.folders.some(folder => folder.id === this.state.folder_id)) {
                    this.state.folder_id = ""; this.invalidate?.({ cancel: false });
                }
                this.populateFolders(this.folders); this.persist({ preserveExecution: true }); this.error(); return true;
            } catch (error) { if (current()) this.error(error.message + (this.items?.length ? " · 保留已恢复预览，连接后可刷新。" : "")); return false; }
            finally {
                if (!this.destroyed && this.generation === generation && this.pendingConnect?.key === connectionKey) {
                    this.pendingConnect = null; this.busy = false; this.render();
                }
            }
        })();
        this.pendingConnect = { generation, key: connectionKey, promise }; return promise;
    }
    async action(action) { if (action === "connect") return this.connect(); }
    destroy() { this.destroyed = true; connectedEditors.delete(this); this.cancelRequests(); }
}

export class ImportEditor extends ConnectedEditor {
    constructor(options) {
        super(); this.items = []; this.lockedItems = []; this.loadedKey = null;
        this.initialize(options, (options.media ? MEDIA_CONNECTION_HTML : CONNECTION_HTML) + (options.media ? `<div class="ea-row ea-types"><button class="ea-toggle" data-action="type-all">加载全部</button><button class="ea-toggle" data-action="type-image">加载图片</button><button class="ea-toggle" data-action="type-video">加载视频</button><button class="ea-toggle" data-action="type-audio">加载音频</button><button class="ea-toggle" data-action="type-model">加载模型</button></div><div class="ea-note">类型按钮可组合；选择完整目录后，点击会加载当前组合。</div>` : "") + `
         <div class="ea-row"><label>加载上限 <input type="number" aria-label="加载上限" min="1" max="500" value="20"></label><label><input type="checkbox" aria-label="包含子目录">包含子目录</label><button data-action="load">${options.media ? "加载所选类型" : "加载图片"}</button><button data-action="refresh">刷新预览</button></div>
         ${options.media ? `<details class="ea-media-options"><summary>视频 / 音频参考设置</summary><div class="ea-row"><label>视频 fps <input type="number" data-setting="video_fps" aria-label="视频帧率" min="1" max="60" value="24"></label><label>起点秒 <input type="number" data-setting="video_start_seconds" aria-label="视频起点秒" min="0" value="0" step="0.1"></label><label>最长秒 <input type="number" data-setting="video_max_seconds" aria-label="视频最长秒" min="0.1" max="60" value="15" step="0.1"></label><label>最长边 <input type="number" data-setting="video_max_edge" aria-label="视频最长边" min="64" max="2048" step="64" value="768"></label></div><div class="ea-row"><label>音频起点秒 <input type="number" data-setting="audio_start_seconds" aria-label="音频起点秒" min="0" step="0.1" value="0"></label><label>音频最长秒 <input type="number" data-setting="audio_max_seconds" aria-label="音频最长秒" min="0.1" max="600" step="0.1" value="15"></label></div><div class="ea-note">视频拆分输出帧批（T8 默认 24fps），音频输出 AUDIO；媒体仅在执行选中资产时解码。</div></details>` : ""}
         <textarea aria-label="${options.media ? "资产检索文字" : "图片检索文字"}" placeholder="例如：1/2/3/4；仅标记匹配${options.media ? "资产" : "图片"}，保留全部预览"></textarea>
         <div class="ea-row"><select aria-label="名称匹配"><option value="exact">精确名称</option><option value="contains">包含文字</option></select><button data-action="search">检索并标记</button><button data-action="text-lock">锁定检索文字</button></div>
         <div class="ea-row"><button data-action="lock" class="ea-primary">锁定输出</button><button data-action="unlock">解锁输出</button><button data-action="clear">清空选择</button></div>
         <div class="ea-status" role="status"></div><div class="ea-note">query 接口可接脚本节点的名称列表。未锁定：每次运行重新读取；刷新预览不会解除输出锁定。</div>
         <div class="ea-grid"></div><div class="ea-error" role="alert"></div>`);
        this.limit = this.root.querySelector('[aria-label="加载上限"]'); this.children = this.root.querySelector('[aria-label="包含子目录"]');
        this.query = this.root.querySelector("textarea"); this.match = this.root.querySelector('[aria-label="名称匹配"]');
        this.limit.value = this.state.limit ?? 20; this.children.checked = !!this.state.include_children;
        this.query.value = this.state.query_text ?? this.state.manual_query ?? ""; this.match.value = this.state.match_mode || "exact";
        this.limit.addEventListener("input", () => { this.state.limit = this.limit.value === "" ? null : Number(this.limit.value); this.invalidate(); this.persist(); this.render(); });
        this.children.addEventListener("change", () => { this.state.include_children = this.children.checked; this.invalidate(); this.persist(); this.render(); });
        this.query.addEventListener("input", () => { this.state.query_text = this.query.value; this.persist(); });
        this.match.addEventListener("change", () => { this.state.match_mode = this.match.value; this.persist(); });
        if (this.media) {
            this.folderCount = this.root.querySelector('[aria-label="Eagle 目录数量"]'); this.folderCount.value = this.state.folder_count;
            this.folderCount.addEventListener("input", () => {
                const count = Math.min(32, Math.max(1, Math.round(Number(this.folderCount.value) || 1)));
                this.state.folder_count = count; this.state.folder_ids = Array.from({ length: count }, (_, i) => this.state.folder_ids[i] || "");
                this.populateFolders(this.folders || []); this.invalidate(); this.persist(); this.render();
            });
            this.folderCount.addEventListener("change", () => { this.folderCount.value = this.state.folder_count; });
            this.root.querySelectorAll("[data-setting]").forEach(input => {
                if (this.state[input.dataset.setting] != null) input.value = this.state[input.dataset.setting];
                else this.state[input.dataset.setting] = Number(input.value);
                input.addEventListener("change", () => { this.state[input.dataset.setting] = Number(input.value); this.invalidate(); this.persist(); this.render(); });
            });
        }
        this.restorePreview(); this.render();
        // ComfyUI applies saved widget values in onConfigure after creation.
        // Defer the default connection so that saved state wins first.
        this.scheduleRestore();
    }
    invalidate({ cancel = true, preserveCache = false, preserveMarker = false } = {}) {
        if (cancel) this.cancelRequests();
        this.loadedKey = null; this.catalogId = null;
        if (!preserveMarker) this.state.preview_loaded = false;
        if (!preserveCache) {
            this.items = []; this.executionItems = null; this.previewWasLoaded = false; this.writePreview?.(null);
        }
    }
    cachePreview() {
        if (this.destroyed || !this.writePreview) return;
        if (this.loadedKey || this.previewWasLoaded) this.writePreview(makePreviewCache(this.state, this.items, this.executionItems));
    }
    restorePreview() {
        const cache = readPreviewCache(this.readPreview?.(), this.state);
        this.items = cache?.items || []; this.executionItems = cache?.executionItems ?? null;
        this.previewWasLoaded = !!cache;
        this.loadedKey = null; this.catalogId = null;
        return cache;
    }
    scheduleRestore() {
        const generation = this.generation;
        this.restorePromise = Promise.resolve().then(async () => {
            if (this.destroyed || this.generation !== generation) return;
            const shouldLoad = this.state.preview_loaded === true || this.previewWasLoaded
                || (this.state.preview_loaded === undefined && validCatalog(this.state));
            const snapshot = this.restoreSnapshot();
            const connected = await this.connect();
            if (this.destroyed || this.generation !== generation) return;
            if (connected && shouldLoad && validCatalog(this.state)) await this.load({ automatic: true });
            await snapshot;
        });
    }
    selectedItems() { return outputSelection(this.items, this.state); }
    outputItems(mediaType) {
        const items = this.state.locked ? this.lockedItems : this.executionItems ?? this.selectedItems();
        return mediaType ? items.filter(item => itemType(item) === mediaType) : items;
    }
    persist({ preserveExecution = false } = {}) {
        if (!preserveExecution) this.executionItems = null;
        super.persist(); this.cachePreview();
    }
    async restoreSnapshot() {
        const sid = this.state.locked?.snapshot_id, generation = this.generation; if (!sid) return;
        try {
            const result = await this.request("snapshot", { snapshot_id: sid });
            if (!this.destroyed && this.generation === generation && this.state.locked?.snapshot_id === sid) {
                this.lockedItems = result.items;
                if (!this.items.length) this.items = [...result.items];
                this.previewWasLoaded = true; this.cachePreview(); this.changed?.(); this.render();
            }
        } catch (error) { if (!this.destroyed && this.generation === generation) this.error(error.message); }
    }
    load({ automatic = false } = {}) {
        if (this.destroyed || !validCatalog(this.state)) return Promise.resolve(false);
        const generation = this.generation, key = catalogKey(this.state);
        if (this.pendingLoad?.generation === generation && this.pendingLoad.key === key) return this.pendingLoad.promise;
        if (this.busy) return Promise.resolve(false);
        this.busy = true; this.error("正在加载所选目录预览…"); this.render();
        const current = () => !this.destroyed && this.generation === generation && key === catalogKey(this.state);
        const promise = (async () => {
            try {
                const result = await this.request("catalog", { settings: JSON.stringify(this.state) });
                if (!current()) return false;
                const executionIds = this.executionItems?.map(item => item.id);
                this.items = result.items; this.catalogId = result.catalog_id; this.loadedKey = key; this.previewWasLoaded = true;
                if (executionIds) { const lookup = new Map(this.items.map(item => [item.id, item])); this.executionItems = executionIds.map(id => lookup.get(id)).filter(Boolean); }
                if (!automatic) { this.state.preview_loaded = true; super.persist(); }
                // Refresh replaces expiring URLs, keeping actual external-query
                // IDs and the independently locked snapshot unchanged.
                this.cachePreview(); this.error(); this.changed?.(); return true;
            } catch (error) { if (current()) this.error(error.message + (this.items.length ? " · 保留已恢复预览，请稍后刷新。" : "")); return false; }
            finally { if (current()) { this.pendingLoad = null; this.busy = false; this.render(); } }
        })();
        this.pendingLoad = { generation, key, promise }; return promise;
    }
    async action(action) {
        if (action === "connect") return this.connect();
        if (action === "load" || action === "refresh") return this.load();
        if (this.media && action.startsWith("type-")) {
            if (this.busy) return;
            const type = action.slice(5), selected = new Set(this.state.types);
            if (type === "all") this.state.types = Object.keys(MEDIA_TYPES);
            else { if (selected.has(type)) selected.delete(type); else if (MEDIA_TYPES[type]) selected.add(type); this.state.types = Object.keys(MEDIA_TYPES).filter(value => selected.has(value)); }
            this.invalidate(); this.persist(); this.render();
            if (validCatalog(this.state)) await this.load();
            return;
        }
        this.error();
        if (action === "search") {
            if (!canSearch(this.state, this.loadedKey, this.busy) || this.state.locked) return;
            const matched = matchItems(this.items, this.query.value, this.state.match_mode);
            this.state.manual_query = this.query.value; this.state.selection_mode = "query"; this.state.selected_ids = matched.items.map(item => item.id);
            this.persist(); if (matched.missing.length) this.error("未找到：" + matched.missing.join(" / ") + "。增大上限或检查名称。");
        } else if (action === "text-lock") { this.state.text_locked = !this.state.text_locked; this.persist(); }
        else if (action === "clear") { if (this.state.locked) return; this.state.selected_ids = []; this.state.selection_mode = "manual"; this.persist(); }
        else if (action === "unlock") { this.state.locked = null; this.lockedItems = []; this.persist(); }
        else if (action === "lock") {
            if (this.state.locked || !canSearch(this.state, this.loadedKey, this.busy)) return;
            const selected = this.outputItems(); if (!selected.length) { this.error(`先检索或点选${this.media ? "资产" : "图片"}，再锁定输出。`); return; }
            this.busy = true; this.render();
            const key = catalogKey(this.state), generation = this.generation;
            const current = () => !this.destroyed && this.generation === generation && catalogKey(this.state) === key;
            try {
                const result = await this.request("lock", { settings: JSON.stringify(this.state), catalog_id: this.catalogId, selected_ids: selected.map(item => item.id) });
                if (!current()) return;
                this.state.locked = result.locked; this.lockedItems = [...selected]; this.persist();
                await this.restoreSnapshot();
            } catch (error) { if (current()) this.error(error.message); }
            finally { if (current()) this.busy = false; }
        }
        this.render();
    }
    clickItem(item) {
        if (this.state.locked || !canSearch(this.state, this.loadedKey, this.busy)) return;
        const ids = this.outputItems().map(item => item.id), index = ids.indexOf(item.id);
        if (index >= 0) ids.splice(index, 1); else ids.push(item.id);
        this.state.selected_ids = ids; this.state.selection_mode = "manual"; this.persist(); this.render();
    }
    render() {
        if (!this.root) return;
        const locked = !!this.state.locked, ready = canSearch(this.state, this.loadedKey, this.busy), count = this.outputItems?.().length || 0;
        const button = name => this.root.querySelector(`[data-action="${name}"]`);
        button("connect").disabled = !!this.busy;
        const valid = validCatalog(this.state);
        button("load").disabled = button("refresh").disabled = this.busy || !valid;
        button("search").disabled = locked || !ready;
        button("lock").disabled = locked || !ready || !count;
        button("unlock").disabled = !locked || this.busy;
        button("clear").disabled = locked || this.busy;
        button("text-lock").textContent = this.state.text_locked ? "解锁检索文字" : "锁定检索文字";
        if (this.query) { this.query.readOnly = !!this.state.text_locked || locked; this.match.disabled = locked; }
        if (this.media) {
            for (const type of ["all", ...Object.keys(MEDIA_TYPES)]) {
                const target = button(`type-${type}`); target.dataset.on = String(type === "all" ? this.state.types.length === 4 : this.state.types.includes(type)); target.disabled = !!this.busy;
            }
        }
        const status = this.root.querySelector(".ea-status"); status.dataset.locked = String(locked);
        status.textContent = locked ? `已锁定输出 ${this.state.locked.count} ${this.media ? "项" : "张"} · 刷新仅更新预览` : `实时读取 · 预览 ${this.items.length} ${this.media ? "项" : "张"} · 输出选中 ${count} ${this.media ? "项" : "张"}`;
        if (this.media && count) status.textContent += " · " + Object.entries(MEDIA_TYPES).map(([type, name]) => `${name} ${this.outputItems(type).length}`).join(" / ");
        const ids = locked ? this.state.locked.ids : this.outputItems().map(item => item.id);
        const grid = this.root.querySelector(".ea-grid"); grid.replaceChildren();
        for (const item of this.items) { const index = ids.indexOf(item.id); const element = card(item, this.imageURL, index + 1, index >= 0, () => this.clickItem(item), this.mediaURL); element.disabled = locked || !ready; element.setAttribute("aria-disabled", String(locked || !ready)); grid.append(element); }
        if (!this.items.length) { const empty = document.createElement("div"); empty.className = "ea-empty"; empty.textContent = this.media ? "选择目录、加载上限和媒体类型后，点击「加载所选类型」" : "选择目录和加载上限后，点击「加载图片」"; grid.append(empty); }
        this.heightChanged?.();
    }
    executed(message) {
        if (this.destroyed || this.state.locked) return;
        const catalog = message.eagle_catalog?.[0], items = message.eagle_assets?.[0];
        if (Array.isArray(catalog)) {
            this.items = catalog; this.catalogId = message.eagle_catalog_id?.[0] || null;
            this.loadedKey = this.catalogId ? catalogKey(this.state) : null;
        }
        // The actual batch query can differ from the local textarea. Sorting must see the execution's selection.
        this.executionItems = Array.isArray(items) ? items : [];
        this.previewWasLoaded = !!this.catalogId || this.items.length > 0; this.cachePreview(); this.changed?.(); this.render();
    }
    restore(raw) {
        this.cancelRequests();
        this.state = parseState(raw); this.host.value = this.state.host; this.token.value = this.state.token || "";
        if (this.media) {
            this.state.folder_count = Math.min(32, Math.max(1, Math.round(Number(this.state.folder_count) || 1)));
            this.state.folder_ids = Array.from({ length: this.state.folder_count }, (_, i) => this.state.folder_ids?.[i] || (i === 0 ? this.state.folder_id : "") || "");
            this.state.types ||= []; this.folderCount.value = this.state.folder_count;
            this.root.querySelectorAll("[data-setting]").forEach(input => { input.value = this.state[input.dataset.setting] ?? input.defaultValue; });
        }
        this.limit.value = this.state.limit; this.children.checked = !!this.state.include_children;
        this.query.value = this.state.query_text ?? this.state.manual_query ?? ""; this.match.value = this.state.match_mode || "exact";
        this.invalidate({ cancel: false, preserveCache: true, preserveMarker: true });
        this.populateFolders(this.folders || []); this.lockedItems = []; this.restorePreview(); this.render(); this.scheduleRestore();
    }
}

export class MediaImportEditor extends ImportEditor {
    constructor(options) { super({ ...options, media: true }); }
}

export class StudioBridgeEditor {
    constructor(options) {
        Object.assign(this, options); this.state = parseState(options.raw, { selected_ids: [] }); this.items = [];
        this.root = createRoot(`<div class="ea-row"><strong>Eagle → Ollama 创作素材</strong><button data-action="clear">清空选择</button></div>
            <div class="ea-status" role="status"></div><div class="ea-note">连接多目录媒体导入的 media_catalog 端口，可看到整个已加载图库。点击选择，再点取消，按点击顺序编号。浮窗中开启 Eagle 素材后，这些素材排在直接上传的文件后面。</div><div class="ea-grid"></div><div class="ea-error"></div>`);
        this.root.querySelector('[data-action="clear"]').addEventListener("click", () => { this.state.selected_ids = []; this.persist(); });
        this.timer = setInterval(() => this.sync(), 400); this.sync(); this.render();
    }
    catalogView() {
        const live = this.upstreamCatalog?.();
        if (live?.disconnected) return live;
        return live?.items?.length || live?.catalog_id || live?.snapshot_id ? live : this.executedSource || live || { items: [] };
    }
    selection() {
        const source = this.catalogView(), lookup = new Map((source.items || []).map(item => [item.id, item]));
        if (!source.catalog_id && !source.snapshot_id) return [];
        return [...new Set(this.state.selected_ids || [])].map(id => lookup.get(id)).filter(Boolean).map(item => ({
            ...(source.catalog_id ? { catalog_id: source.catalog_id } : { snapshot_id: source.snapshot_id }),
            item_id: item.id, name: item.name, kind: itemType(item), ext: item.ext, preview: item.preview, media_url: item.media_url, model_url: item.model_url,
        }));
    }
    outputItems() {
        const source = this.catalogView(), lookup = new Map((source.items || []).map(item => [item.id, item]));
        return [...new Set(this.state.selected_ids || [])].map(id => lookup.get(id)).filter(Boolean);
    }
    persist() { this.save(JSON.stringify(this.state)); this.render(); this.changed?.(); this.selectionChanged?.(); }
    sync() {
        if (this.destroyed) return;
        const source = this.catalogView(), key = JSON.stringify(source);
        if (key === this.sourceKey) return;
        this.sourceKey = key; this.items = source.items || []; this.render(); this.selectionChanged?.();
    }
    render() {
        const source = this.catalogView(), ready = !!(source.catalog_id || source.snapshot_id), ids = this.state.selected_ids || [];
        const available = new Set(this.items.map(item => item.id));
        const missing = ready ? [...new Set(ids)].filter(id => !available.has(id)).length : 0;
        this.root.querySelector(".ea-status").textContent = `图库 ${this.items.length} 项 · 已选 ${this.outputItems().length} 项 · ${ready ? "浮窗可读取" : "等待上游加载预览"}`
            + (missing ? ` · ${missing} 个旧选择不在当前上游中，已跳过` : "");
        const grid = this.root.querySelector(".ea-grid"); grid.replaceChildren();
        for (const item of this.items) {
            const index = ids.indexOf(item.id), element = card(item, this.imageURL, index + 1, index >= 0, () => {
                const selected = [...(this.state.selected_ids || [])], position = selected.indexOf(item.id);
                if (position >= 0) selected.splice(position, 1); else selected.push(item.id);
                this.state.selected_ids = selected; this.persist();
            }, this.mediaURL);
            element.disabled = !ready; element.setAttribute("aria-disabled", String(!ready)); grid.append(element);
        }
        if (!this.items.length) { const empty = document.createElement("div"); empty.className = "ea-empty"; empty.textContent = "连接媒体目录接口，然后在上游导入节点加载素材"; grid.append(empty); }
    }
    executed(message) {
        const source = message.eagle_studio_catalog?.[0];
        if (source?.items) { this.executedSource = source; this.sourceKey = null; this.sync(); }
    }
    restore(raw) { this.state = parseState(raw, { selected_ids: [] }); this.executedSource = null; this.sourceKey = null; this.sync(); this.render(); this.selectionChanged?.(); }
    destroy() { this.destroyed = true; clearInterval(this.timer); this.root.querySelectorAll("audio,video").forEach(player => player.pause()); }
}

export class SortEditor {
    constructor(options) {
        Object.assign(this, options); this.state = parseState(options.raw, { mode: "input", order: [], descending: false }); this.items = [];
        this.root = createRoot(`<div class="ea-row"><label class="ea-grow">排序字段 <select class="ea-grow" aria-label="排序字段"></select></label><label><input type="checkbox" aria-label="降序">降序</label></div>
          <div class="ea-row"><button class="ea-toggle" data-action="filter">输出点选</button><button data-action="all">全选</button><button data-action="none">取消全选</button></div>
          <div class="ea-row"><button data-action="manual">手动点击排序</button><button data-action="clear">重选顺序</button><button data-action="input">恢复输入顺序</button></div>
          <div class="ea-status" role="status"></div><div class="ea-note">点选筛选开启时，只输出点选素材，按点击顺序编号；再点取消。关闭筛选时输出全部，未指定顺序的素材追加在后。</div><div class="ea-grid"></div><div class="ea-error"></div>`);
        this.mode = this.root.querySelector("select");
        for (const [value, name] of Object.entries(SORT_MODES)) { const option = document.createElement("option"); option.value = value; option.textContent = name; this.mode.append(option); }
        this.descending = this.root.querySelector("input"); this.mode.value = this.state.mode; this.descending.checked = !!this.state.descending;
        this.mode.addEventListener("change", () => { this.state.mode = this.mode.value; this.persist(); });
        this.descending.addEventListener("change", () => { this.state.descending = this.descending.checked; this.persist(); });
        this.root.querySelectorAll("button[data-action]").forEach(button => button.addEventListener("click", () => {
            const action = button.dataset.action;
            if (action === "filter") {
                this.state.filter_mode = !this.state.filter_mode;
                if (this.state.filter_mode && !Array.isArray(this.state.selected_ids)) this.state.selected_ids = [...(this.state.order || [])];
            } else if (action === "all") {
                this.state.filter_mode = true; this.state.selected_ids = this.items.map(item => item.id); this.state.order = [...this.state.selected_ids]; this.state.mode = "manual";
            } else if (action === "none") {
                this.state.filter_mode = true; this.state.selected_ids = []; this.state.order = []; this.state.mode = "manual";
            } else if (action === "input") this.state.mode = "input";
            else { this.state.mode = "manual"; if (action === "clear") { this.state.order = []; if (this.state.filter_mode) this.state.selected_ids = []; } }
            this.mode.value = this.state.mode; this.persist();
        }));
        this.timer = setInterval(() => this.sync(), 400); this.sync(); this.render();
    }
    persist() { this.save(JSON.stringify(this.state)); this.render(); }
    sync() {
        const items = this.upstreamItems() || [];
        const key = JSON.stringify(items);
        if (key === this.sourceKey) return;
        this.sourceKey = key; this.items = items; this.render();
    }
    outputItems(mediaType) {
        const result = sortItems(this.items, this.state);
        return mediaType ? result.filter(item => itemType(item) === mediaType) : result;
    }
    render() {
        const ordered = this.outputItems(), grid = this.root.querySelector(".ea-grid"); grid.replaceChildren();
        const filter = this.root.querySelector('[data-action="filter"]'); filter.dataset.on = String(!!this.state.filter_mode); filter.textContent = `输出点选：${this.state.filter_mode ? "开启" : "关闭（输出全部）"}`;
        this.root.querySelector(".ea-status").textContent = `输入 ${this.items.length} · 输出 ${ordered.length} ${this.mediaType && this.mediaType !== "image" ? "项" : "张"} · ${MEDIA_TYPES[this.mediaType || "image"]} · ${SORT_MODES[this.state.mode] || "输入顺序"}`;
        this.descending.disabled = this.state.mode === "input" || this.state.mode === "manual";
        const rank = new Map(ordered.map((item, index) => [item.id, index + 1]));
        const display = this.state.filter_mode ? [...ordered, ...this.items.filter(item => !rank.has(item.id))] : ordered;
        for (const item of display) grid.append(card(item, this.imageURL, rank.get(item.id) || 0, this.state.filter_mode ? rank.has(item.id) : this.state.order?.includes(item.id), () => {
            this.state.mode = "manual"; this.mode.value = "manual";
            const order = [...(this.state.filter_mode ? this.state.selected_ids || [] : this.state.order || [])], position = order.indexOf(item.id);
            if (position >= 0) order.splice(position, 1); else order.push(item.id);
            this.state.order = order; if (this.state.filter_mode) this.state.selected_ids = [...order]; this.persist();
        }, this.mediaURL));
        if (!this.items.length) { const empty = document.createElement("div"); empty.className = "ea-empty"; empty.textContent = `连接对应资产接口，检索或点选${MEDIA_TYPES[this.mediaType || "image"]}后即可排序`; grid.append(empty); }
    }
    executed(message) {
        const full = message.eagle_catalog?.[0], items = message.eagle_assets?.[0], upstream = this.upstreamItems() || [];
        if (Array.isArray(full) || Array.isArray(items)) {
            this.items = Array.isArray(full) ? full : upstream.length ? upstream : items;
            this.sourceKey = JSON.stringify(upstream); this.render();
        }
    }
    restore(raw) { this.state = parseState(raw, { mode: "input", order: [], descending: false }); this.mode.value = this.state.mode; this.descending.checked = !!this.state.descending; this.render(); }
    destroy() { clearInterval(this.timer); }
}

export class ExportEditor extends ConnectedEditor {
    constructor(options) {
        super(); this.previews = []; this.modelViewers = []; this.previewGeneration = 0;
        this.initialize(options, CONNECTION_HTML + `<div class="ea-row"><button class="ea-toggle" data-action="eagle">保存到 Eagle：关闭</button><button class="ea-toggle" data-action="output">保存到 output：关闭</button></div>
          <div class="ea-row"><label class="ea-grow">Eagle 标签 <input class="ea-grow" aria-label="Eagle 标签" placeholder="逗号分隔，可留空"></label></div>
          <label class="ea-annotation">Eagle 注释 <textarea aria-label="Eagle 注释" placeholder="可填写完整提示词；连接 annotation 接口时使用接口内容"></textarea></label>
          <div class="ea-status" role="status"></div><div class="ea-note">预览始终开启。两个保存开关均关闭时，只生成 ComfyUI 临时预览。</div><div class="ea-export-media" aria-label="导出媒体预览"><div class="ea-empty">执行后显示实际导出文件的预览，双击放大</div></div><div class="ea-error" role="alert"></div>`);
        this.tags = this.root.querySelector('[aria-label="Eagle 标签"]'); this.tags.value = this.state.tags || "";
        this.tags.addEventListener("change", () => { this.state.tags = this.tags.value; this.persist(); });
        this.annotation = this.root.querySelector('[aria-label="Eagle 注释"]'); this.annotation.value = this.state.annotation || "";
        this.annotation.addEventListener("input", () => { this.state.annotation = this.annotation.value; this.persist(); });
        this.tags.placeholder = "逗号分隔；连接 tags 接口时使用接口内容";
        this.connect();
    }
    async action(action) {
        if (action === "connect") return this.connect();
        if (action === "eagle") this.state.save_eagle = !this.state.save_eagle;
        if (action === "output") this.state.save_output = !this.state.save_output;
        this.persist(); this.render();
    }
    render() {
        if (!this.root) return;
        for (const [action, field, name] of [["eagle", "save_eagle", "Eagle"], ["output", "save_output", "output"]]) {
            const button = this.root.querySelector(`[data-action="${action}"]`); button.dataset.on = String(!!this.state[field]); button.textContent = `保存到 ${name}：${this.state[field] ? "开启" : "关闭"}`;
        }
        this.root.querySelector('[data-action="connect"]').disabled = !!this.busy;
        this.root.querySelector(".ea-status").textContent = this.lastStatus || "等待工作流执行 · 两个保存位置独立控制";
    }
    renderMedia() {
        const container = this.root.querySelector(".ea-export-media"); if (!container) return;
        ++this.previewGeneration; const generation = this.previewGeneration;
        container.querySelectorAll("audio,video").forEach(player => { player.pause(); player.removeAttribute("src"); player.load(); });
        this.modelViewers.forEach(viewer => viewer.dispose()); this.modelViewers = []; container.replaceChildren();
        for (const item of this.previews) {
            const type = item.media_type || this.mediaType, ext = String(item.ext || item.filename?.split(".").pop() || "").toLowerCase();
            const element = document.createElement("article"); element.className = "ea-export-card"; element.dataset.mediaType = type;
            element.dataset.previewIndex = String(container.children.length);
            const name = document.createElement("div"); name.className = "ea-export-name"; name.textContent = `${item.name || item.filename || MEDIA_TYPES[type]} · ${ext.toUpperCase()} · ${item.type === "output" ? "output" : "临时预览"}`;
            element.append(name); container.append(element);
            const descriptorURL = item.media_url || item.preview_url || (item.filename ? this.imageURL({ filename: item.filename, subfolder: item.subfolder || "", type: item.type || "temp" }) : "");
            const url = item.media_url || item.preview_url ? this.mediaURL(descriptorURL) : descriptorURL;
            if (type === "image" && url) {
                const image = document.createElement("img"); image.src = url; image.alt = item.name || item.filename; image.style.cssText = "display:block;width:100%;max-height:280px;object-fit:contain"; element.append(image);
            } else if ((type === "audio" || type === "video") && url) {
                const player = document.createElement(type); player.controls = true; player.preload = "metadata"; player.src = url; player.setAttribute("aria-label", `${MEDIA_TYPES[type]}导出预览`);
                if (type === "video" && (item.preview || item.preview_url)) player.poster = item.preview ? this.imageURL(item.preview) : this.mediaURL(item.preview_url);
                for (const event of ["pointerdown", "click", "keydown"]) player.addEventListener(event, e => e.stopPropagation());
                element.append(player);
            } else if (type === "model" && url && canPreviewModel(ext)) {
                const viewport = document.createElement("div"); viewport.className = "ea-model-viewer";
                const status = document.createElement("div"); status.className = "ea-model-status"; status.textContent = "正在加载实际 3D 文件…";
                element.append(viewport, status);
                const viewer = createModelPreview(viewport, { url: this.mediaURL(item.preview_url || descriptorURL), ext, apiURL: this.mediaURL }); this.modelViewers.push(viewer);
                viewer.ready.then(() => {
                    if (this.destroyed || generation !== this.previewGeneration) return;
                    status.textContent = "拖动旋转 · 滚轮缩放 · 右键平移";
                    const reset = document.createElement("button"); reset.type = "button"; reset.textContent = "重置视角"; reset.addEventListener("click", () => viewer.reset());
                    element.querySelector(".ea-export-links")?.append(reset); this.heightChanged?.();
                }).catch(error => {
                    viewer.dispose(); if (this.destroyed || generation !== this.previewGeneration) return;
                    viewport.remove(); status.textContent = `3D 预览未加载：${error.message || "请检查格式、纹理资源或浏览器 WebGL"}。可下载文件后查看。`;
                });
            } else {
                const placeholder = document.createElement("div"); placeholder.className = "ea-export-file";
                placeholder.textContent = type === "model" ? `${ext.toUpperCase()} 模型文件 · 此格式暂不支持节点内 3D 预览` : "文件预览不可用"; element.append(placeholder);
            }
            const links = document.createElement("div"); links.className = "ea-export-links";
            if (url) { const download = document.createElement("a"); download.href = url; download.download = item.filename || item.name || ""; download.textContent = "下载文件"; links.append(download); }
            element.append(links);
        }
        if (!this.previews.length) { const empty = document.createElement("div"); empty.className = "ea-empty"; empty.textContent = "本次没有导出媒体"; container.append(empty); }
        this.heightChanged?.();
    }
    executed(message) {
        this.lastStatus = message.eagle_status?.[0] || "执行完成";
        if (this.mediaType) {
            const media = message.eagle_media; this.previews = Array.isArray(media?.[0]) ? media[0] : Array.isArray(media) ? media : (message.images || []).map(item => ({ ...item, name: item.filename, media_type: "image" }));
            this.renderMedia();
        }
        this.render();
    }
    restore(raw) { this.state = parseState(raw); this.host.value = this.state.host; this.token.value = this.state.token || ""; this.tags.value = this.state.tags || ""; this.annotation.value = this.state.annotation || ""; this.populateFolders(this.folders || []); this.render(); }
    destroy() {
        ++this.previewGeneration; this.modelViewers.forEach(viewer => viewer.dispose()); this.modelViewers = [];
        this.root.querySelectorAll("audio,video").forEach(player => { player.pause(); player.removeAttribute("src"); player.load(); });
        super.destroy();
    }
}
