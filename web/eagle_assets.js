import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ImportEditor, MediaImportEditor, SortEditor, ExportEditor, StudioBridgeEditor, refreshExportTargets } from "./editors.js";
import { mediaCatalogView } from "./model.js";
import { responsiveEditor } from "./layout.js";
import { imageStudioBridge } from "./image_studio_bridge.js";

const SORT_TYPES = { EagleAssetSort: "image", EagleVideoSort: "video", EagleAudioSort: "audio", EagleModelSort: "model" };
const SPLIT_TYPES = { EagleAssetSplit: ["image", "IMAGE", 9], EagleVideoSplit: ["video", "IMAGE", 3], EagleAudioSplit: ["audio", "AUDIO", 3], EagleModelSplit: ["model", "STRING", 9] };
const EXPORT_TYPES = { EagleAssetExport: "image", EagleAudioExport: "audio", EagleVideoExport: "video", EagleModelExport: "model" };
const studioNodes = new Set();
const imageStudioNodes = new Set();
const resolvingCatalogs = new Set();
function studioSelection() {
    return [...studioNodes].filter(node => node.graph === app.graph && app.graph?.getNodeById(node.id) === node)
        .flatMap(node => (node.eagleAssetsEditor?.selection?.() || []).map(item => ({ ...item, bridge_id: node.id })));
}
function announceStudioSelection() { globalThis.dispatchEvent(new CustomEvent("eagle-assets-studio-selection", { detail: studioSelection() })); }
function imageStudioSelection() {
    return [...imageStudioNodes].filter(node => node.graph === app.graph && app.graph?.getNodeById(node.id) === node)
        .flatMap(node => node.eagleImageStudioBridge?.selection() || []);
}
function imageStudioSources(node) {
    const sources = [], pending = [], fingerprints = [];
    const graph = node.graph || app.graph;
    const linkFor = input => graph.links?.get?.(input?.link) || graph.links?.[input?.link];
    for (const input of node.inputs || []) {
        if (input.link == null) continue;
        const slot = Number(input.name.slice(6)), seen = new Set([node.id]);
        let link = linkFor(input), source = link && graph.getNodeById(link.origin_id);
        while (source && /reroute/i.test(source.comfyClass || source.type || "") && !seen.has(source.id)) {
            seen.add(source.id); link = linkFor(source.inputs?.[0]); source = link && graph.getNodeById(link.origin_id);
        }
        let files = [], loadImage = false;
        if (source && (source.comfyClass || source.type) === "LoadImage") {
            loadImage = true;
            let filename = String(source.widgets?.find(widget => widget.name === "image")?.value || "").replaceAll("\\", "/");
            const annotated = filename.match(/\s*\[(input|output|temp)\]$/), type = annotated?.[1] || "input";
            if (annotated) filename = filename.slice(0, annotated.index);
            const slash = filename.lastIndexOf("/");
            if (filename) files = [{ filename: filename.slice(slash + 1), subfolder: slash < 0 ? "" : filename.slice(0, slash), type }];
        } else if (source && link.origin_slot === 0) {
            files = (app.nodeOutputs?.[source.id]?.images || []).filter(item => item && /\.(png|jpe?g|webp|bmp|tiff?|gif|avif)$/i.test(item.filename || ""))
                .map(item => ({ filename: item.filename, subfolder: item.subfolder || "", type: item.type || "temp" }));
        }
        fingerprints.push([slot, source?.id ?? null, link?.origin_slot ?? null, files]);
        if (files.length) sources.push({ slot, files });
        else if (!loadImage) pending.push(slot);
    }
    return { key: JSON.stringify(fingerprints), sources, pending };
}
globalThis.EagleAssetsStudioBridge = { getSelection: studioSelection, getImageSelection: imageStudioSelection };

function imageURL(preview) {
    if (!preview) return "";
    return api.apiURL("/view?" + new URLSearchParams(preview));
}
async function request(action, body) {
    const response = await api.fetchApi(`/eagle_assets/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Eagle 操作失败");
    return data;
}
function upstreamEditor(node, inputName = "assets") {
    let current = node, slot = current.inputs?.findIndex(input => input.name === inputName);
    const seen = new Set([node.id]);
    for (let depth = 0; depth < 64; depth++) {
        const id = current.inputs?.[slot]?.link; if (id == null) return null;
        const graph = current.graph || app.graph, link = graph.links?.get?.(id) || graph.links?.[id];
        if (!link || seen.has(link.origin_id)) return null;
        seen.add(link.origin_id); current = graph.getNodeById(link.origin_id);
        if (!current) return null;
        if (current.eagleAssetsEditor?.outputItems) return { editor: current.eagleAssetsEditor, slot: link.origin_slot };
        if (!/reroute/i.test(current.comfyClass || current.type || "")) return null;
        slot = 0;
    }
    return null;
}
function upstreamCatalog(node) {
    if (resolvingCatalogs.has(node)) return { items: [], disconnected: true };
    resolvingCatalogs.add(node);
    try {
        const editor = upstreamEditor(node, "media")?.editor;
        if (!editor) return { items: [], disconnected: true };
        return mediaCatalogView(editor);
    } finally { resolvingCatalogs.delete(node); }
}
function setupSplit(node, [prefix, type, defaultCount]) {
    const widget = node.widgets?.find(widget => widget.name === "output_count"); if (!widget) return;
    const sync = () => {
        const count = Math.min(64, Math.max(1, Math.round(Number(widget.value) || defaultCount)));
        widget.value = count;
        while ((node.outputs?.length || 0) > count) node.removeOutput(node.outputs.length - 1);
        while ((node.outputs?.length || 0) < count) node.addOutput(`${prefix}_${node.outputs.length + 1}`, type);
        node.setSize([Math.max(node.size[0], 270), Math.max(110, count * 22 + 85)]);
        node.setDirtyCanvas?.(true, true);
    };
    const callback = widget.callback;
    widget.callback = function () { const result = callback?.apply(this, arguments); sync(); return result; };
    const configured = node.onConfigure;
    node.onConfigure = function () { const result = configured?.apply(this, arguments); sync(); return result; };
    sync();
}
function ensureMediaCatalogOutput(node) {
    // Older saved workflows have four serialized outputs. Append the new port
    // without shifting their existing image/video/audio/model connections.
    if (node.outputs?.length === 4) node.addOutput("media_catalog", "EAGLE_MEDIA_CATALOG");
}

function ensureExportPorts(node) {
    if (!node.inputs?.some(input => input.name === "eagle_target")) node.addInput?.("eagle_target", "EAGLE_EXPORT_TARGET");
    if (!node.outputs?.some(output => output.name === "eagle_target")) node.addOutput?.("eagle_target", "EAGLE_EXPORT_TARGET");
}
function upstreamExport(node) {
    let current = node, slot = current.inputs?.findIndex(input => input.name === "eagle_target");
    const seen = new Set([node.id]);
    for (let depth = 0; depth < 64; depth++) {
        const id = current.inputs?.[slot]?.link; if (id == null) return null;
        const graph = current.graph || app.graph, link = graph.links?.get?.(id) || graph.links?.[id];
        if (!link || seen.has(link.origin_id)) return null;
        seen.add(link.origin_id); current = graph.getNodeById(link.origin_id);
        if (!current) return null;
        if (EXPORT_TYPES[current.comfyClass || current.type] && !current.eagleAssetsEditor?.destroyed) return current.eagleAssetsEditor || null;
        if (!/reroute/i.test(current.comfyClass || current.type || "")) return null;
        slot = 0;
    }
    return null;
}

app.registerExtension({
    name: "EagleAssets.ImportSortSplitExport",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "EagleImageStudioBridge") {
            const created = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const result = created?.apply(this, arguments);
                const editor = this.eagleImageStudioBridge = imageStudioBridge(this, { request, changed: announceStudioSelection, imageURL,
                    readSources: () => imageStudioSources(this), active: () => !app.configuringGraph && this.graph === app.graph && app.graph.getNodeById(this.id) === this });
                const layout = responsiveEditor(this, editor);
                const widget = this.addDOMWidget("eagle_image_preview", "eagle_assets", editor.root, layout.options); widget.options.serialize = false;
                editor.heightChanged = layout.refresh;
                this.onDrawBackground = function () {};
                this.setSize([Math.max(this.size[0], 420), Math.max(this.size[1], 400)]);
                imageStudioNodes.add(this);
                const removed = this.onRemoved;
                this.onRemoved = function () { imageStudioNodes.delete(this); layout.dispose(); this.eagleImageStudioBridge.dispose(); const value = removed?.apply(this, arguments); announceStudioSelection(); return value; };
                return result;
            };
            return;
        }
        if (!["EagleAssetImport", "EagleMediaImport", "EagleStudioBridge", ...Object.keys(EXPORT_TYPES), ...Object.keys(SORT_TYPES), ...Object.keys(SPLIT_TYPES)].includes(nodeData.name)) return;
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = created?.apply(this, arguments);
            if (nodeData.name === "EagleMediaImport") ensureMediaCatalogOutput(this);
            if (SPLIT_TYPES[nodeData.name]) { setupSplit(this, SPLIT_TYPES[nodeData.name]); return result; }
            const sortType = SORT_TYPES[nodeData.name], exportType = EXPORT_TYPES[nodeData.name], mediaType = sortType || exportType;
            if (exportType) ensureExportPorts(this);
            const importing = nodeData.name === "EagleAssetImport" || nodeData.name === "EagleMediaImport";
            const field = sortType ? "sort_settings" : "settings";
            const stateWidget = this.widgets?.find(widget => widget.name === field);
            if (!stateWidget || typeof this.addDOMWidget !== "function") { console.warn("[EagleAssets] 编辑器初始化失败，请刷新或检查前端版本。"); return result; }
            stateWidget.type = "hidden"; stateWidget.computeSize = () => [0, -4]; stateWidget.serializeValue = () => stateWidget.value;
            if (stateWidget.inputEl) stateWidget.inputEl.style.display = "none";
            const options = {
                raw: stateWidget.value, request, imageURL, mediaURL: url => api.apiURL(url), mediaType,
                upstreamTarget: () => upstreamExport(this),
                upstreamCatalog: () => upstreamCatalog(this), selectionChanged: announceStudioSelection,
                readPreview: () => this.properties?.[exportType ? "eagle_assets_export_preview" : "eagle_assets_preview"],
                writePreview: value => {
                    this.properties ||= {};
                    const key = exportType ? "eagle_assets_export_preview" : "eagle_assets_preview";
                    if (value) this.properties[key] = value;
                    else delete this.properties[key];
                },
                save: raw => { if (stateWidget.value !== raw) { stateWidget.value = raw; this.graph?.change?.(); this.setDirtyCanvas?.(true, true); } },
                upstreamItems: () => upstreamEditor(this)?.editor.outputItems(mediaType) || [],
                changed: () => this.setDirtyCanvas?.(true, true),
            };
            const editor = nodeData.name === "EagleAssetImport" ? new ImportEditor(options)
                : nodeData.name === "EagleMediaImport" ? new MediaImportEditor(options)
                : nodeData.name === "EagleStudioBridge" ? new StudioBridgeEditor(options)
                : sortType ? new SortEditor(options) : new ExportEditor(options);
            this.eagleAssetsEditor = editor;
            if (exportType) {
                // Native history/Assets still receive images/video/audio/3d.
                // This node already renders those files in its DOM editor.
                this.onDrawBackground = function () {};
            }
            if (nodeData.name === "EagleStudioBridge") { studioNodes.add(this); announceStudioSelection(); }
            const height = nodeData.name === "EagleMediaImport" ? 1060 : nodeData.name === "EagleStudioBridge" ? 560 : importing ? 850 : sortType ? 560 : exportType === "image" ? 440 : exportType === "audio" ? 630 : 820;
            const layout = responsiveEditor(this, editor);
            const widget = this.addDOMWidget("eagle_assets_editor", "eagle_assets", editor.root, layout.options); widget.options.serialize = false;
            this.setSize([Math.max(this.size[0], 550), Math.max(this.size[1], height + 90)]);
            editor.heightChanged = layout.refresh;
            const configured = this.onConfigure;
            this.onConfigure = function () {
                const result = configured?.apply(this, arguments);
                if (nodeData.name === "EagleMediaImport") ensureMediaCatalogOutput(this);
                if (exportType) ensureExportPorts(this);
                editor.restore(stateWidget.value); layout.refresh(); return result;
            };
            const executed = this.onExecuted;
            this.onExecuted = function (message) {
                // Never delete fields on the shared output: other ComfyUI
                // consumers (including history thumbnails) use the same object.
                const local = exportType ? { ...message, images: [], video: [], audio: [], "3d": [] } : message;
                const result = executed?.call(this, local);
                editor.executed?.(message); return result;
            };
            const removed = this.onRemoved;
            this.onRemoved = function () { layout.dispose(); editor.destroy?.(); if (studioNodes.delete(this)) announceStudioSelection(); return removed?.apply(this, arguments); };
            if (exportType) {
                const connectionsChanged = this.onConnectionsChange;
                this.onConnectionsChange = function () { const result = connectionsChanged?.apply(this, arguments); refreshExportTargets(); return result; };
                refreshExportTargets();
            }
            return result;
        };
    },
});
