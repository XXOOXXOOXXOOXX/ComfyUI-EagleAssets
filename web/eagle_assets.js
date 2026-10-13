import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ImportEditor, MediaImportEditor, SortEditor, ExportEditor } from "./editors.js";

const SORT_TYPES = { EagleAssetSort: "image", EagleVideoSort: "video", EagleAudioSort: "audio", EagleModelSort: "model" };
const SPLIT_TYPES = { EagleAssetSplit: ["image", "IMAGE", 9], EagleVideoSplit: ["video", "IMAGE", 3], EagleAudioSplit: ["audio", "AUDIO", 3], EagleModelSplit: ["model", "STRING", 9] };
const EXPORT_TYPES = { EagleAssetExport: "image", EagleAudioExport: "audio", EagleVideoExport: "video", EagleModelExport: "model" };

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
function upstreamEditor(node) {
    let current = node, slot = current.inputs?.findIndex(input => input.name === "assets");
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

app.registerExtension({
    name: "EagleAssets.ImportSortSplitExport",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!["EagleAssetImport", "EagleMediaImport", ...Object.keys(EXPORT_TYPES), ...Object.keys(SORT_TYPES), ...Object.keys(SPLIT_TYPES)].includes(nodeData.name)) return;
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = created?.apply(this, arguments);
            if (SPLIT_TYPES[nodeData.name]) { setupSplit(this, SPLIT_TYPES[nodeData.name]); return result; }
            const sortType = SORT_TYPES[nodeData.name], exportType = EXPORT_TYPES[nodeData.name], mediaType = sortType || exportType;
            const importing = nodeData.name === "EagleAssetImport" || nodeData.name === "EagleMediaImport";
            const field = sortType ? "sort_settings" : "settings";
            const stateWidget = this.widgets?.find(widget => widget.name === field);
            if (!stateWidget || typeof this.addDOMWidget !== "function") { console.warn("[EagleAssets] 编辑器初始化失败，请刷新或检查前端版本。"); return result; }
            stateWidget.type = "hidden"; stateWidget.computeSize = () => [0, -4]; stateWidget.serializeValue = () => stateWidget.value;
            if (stateWidget.inputEl) stateWidget.inputEl.style.display = "none";
            const options = {
                raw: stateWidget.value, request, imageURL, mediaURL: url => api.apiURL(url), mediaType,
                readPreview: () => this.properties?.eagle_assets_preview,
                writePreview: value => {
                    this.properties ||= {};
                    if (value) this.properties.eagle_assets_preview = value;
                    else delete this.properties.eagle_assets_preview;
                },
                save: raw => { if (stateWidget.value !== raw) { stateWidget.value = raw; this.graph?.change?.(); this.setDirtyCanvas?.(true, true); } },
                upstreamItems: () => upstreamEditor(this)?.editor.outputItems(mediaType) || [],
                changed: () => this.setDirtyCanvas?.(true, true),
            };
            const editor = nodeData.name === "EagleAssetImport" ? new ImportEditor(options)
                : nodeData.name === "EagleMediaImport" ? new MediaImportEditor(options)
                : sortType ? new SortEditor(options) : new ExportEditor(options);
            this.eagleAssetsEditor = editor;
            let height = nodeData.name === "EagleMediaImport" ? 1060 : importing ? 850 : sortType ? 510 : exportType === "image" ? 440 : exportType === "audio" ? 630 : 820;
            const minimumHeight = height;
            const widget = this.addDOMWidget("eagle_assets_editor", "eagle_assets", editor.root, {
                serialize: false, hideOnZoom: false, getMinHeight: () => minimumHeight, getHeight: () => height,
            }); widget.options.serialize = false;
            this.setSize([Math.max(this.size[0], 550), Math.max(this.size[1], height + 90)]);
            if (nodeData.name === "EagleMediaImport" || (exportType && exportType !== "image")) {
                editor.heightChanged = () => {
                    const required = Math.max(minimumHeight, Math.ceil(editor.root.scrollHeight));
                    if (required === height) return;
                    height = required; this.setSize([Math.max(this.size[0], 550), Math.max(this.size[1], height + 90)]); this.setDirtyCanvas?.(true, true);
                };
                editor.root.querySelector("details")?.addEventListener("toggle", () => editor.heightChanged());
            }
            const configured = this.onConfigure;
            this.onConfigure = function () { const result = configured?.apply(this, arguments); editor.restore(stateWidget.value); return result; };
            const executed = this.onExecuted;
            this.onExecuted = function (message) { const result = executed?.apply(this, arguments); editor.executed?.(message); return result; };
            const removed = this.onRemoved;
            this.onRemoved = function () { editor.destroy?.(); return removed?.apply(this, arguments); };
            return result;
        };
    },
});
