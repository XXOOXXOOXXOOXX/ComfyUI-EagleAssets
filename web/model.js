const EXTENSIONS = {
    image: ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "gif", "avif"],
    video: ["mp4", "mov", "mkv", "webm", "avi", "m4v", "mpg", "mpeg", "wmv", "ts"],
    audio: ["wav", "mp3", "flac", "m4a", "aac", "ogg", "opus", "aiff", "aif", "wma"],
    model: ["obj", "glb", "gltf", "fbx", "stl", "ply", "usdz", "spz", "splat", "ksplat"],
};
const ASSET_EXT = new Set(Object.values(EXTENSIONS).flat());
export const MEDIA_TYPES = { image: "图片", video: "视频", audio: "音频", model: "模型" };
export function mediaCatalogView(editor) {
    if (editor.catalogView) return editor.catalogView();
    const snapshot_id = editor.state?.locked?.snapshot_id;
    if (snapshot_id) {
        // A refreshed preview is independent from the locked execution output.
        // Always use snapshot descriptors/URLs, even while a live catalog exists.
        const ids = new Set(editor.state.locked.ids || []);
        return { snapshot_id, items: (editor.lockedItems || []).filter(item => ids.has(item.id)) };
    }
    return { catalog_id: editor.catalogId || null, items: editor.items || [] };
}
export function itemType(item) {
    if (item.media_type) return item.media_type;
    const ext = String(item.ext || "").toLowerCase();
    return Object.entries(EXTENSIONS).find(([, values]) => values.includes(ext))?.[0] || "image";
}
export function normalizeName(value) {
    let text = String(value ?? "").normalize("NFKC").trim().toLowerCase();
    const dot = text.lastIndexOf(".");
    if (dot >= 0 && ASSET_EXT.has(text.slice(dot + 1))) text = text.slice(0, dot);
    return text;
}
export function queryTokens(text) { return [...new Set(String(text || "").split(/[/\n\r,，;；]+/).filter(t => t.trim()).map(normalizeName))]; }
export function matchItems(items, text, mode = "exact") {
    const result = [], used = new Set(), missing = [];
    for (const token of queryTokens(text)) {
        const matches = items.filter(item => mode === "contains" ? normalizeName(item.name).includes(token) : normalizeName(item.name) === token);
        if (!matches.length) missing.push(token);
        for (const item of matches) if (!used.has(item.id)) { result.push(item); used.add(item.id); }
    }
    return { items: result, missing };
}
export function outputSelection(items, state) {
    if (state.selection_mode === "query") return matchItems(items, state.manual_query, state.match_mode).items;
    const lookup = new Map(items.map(item => [item.id, item]));
    return (state.selected_ids || []).map(id => lookup.get(id)).filter(Boolean);
}
export const SORT_MODES = { input: "输入 / 检索顺序", manual: "手动点击顺序", name: "名称（自然排序）", created: "创建时间", modified: "修改时间", width: "宽度", height: "高度", duration: "时长", size: "文件大小", tags: "标签" };
function naturalCompare(a, b) {
    const aa = String(a ?? "").toLowerCase().split(/(\d+)/), bb = String(b ?? "").toLowerCase().split(/(\d+)/);
    for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
        if (i >= aa.length) return -1; if (i >= bb.length) return 1;
        const x = /^\d+$/.test(aa[i]) ? Number(aa[i]) : aa[i], y = /^\d+$/.test(bb[i]) ? Number(bb[i]) : bb[i];
        if (x === y) continue;
        if (typeof x !== typeof y) return typeof x === "number" ? -1 : 1;
        return x < y ? -1 : 1;
    }
    return 0;
}
export function sortItems(items, state) {
    const lookup = new Map(items.map(item => [item.id, item]));
    const result = state.filter_mode ? [...new Set(state.selected_ids || [])].map(id => lookup.get(id)).filter(Boolean) : [...items];
    const mode = state.mode || "input";
    if (mode === "manual") {
        const order = [...new Set(state.order || [])], rank = new Map(order.map((id, i) => [id, i]));
        return result.sort((a, b) => (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length));
    }
    if (mode === "input") return result;
    const value = item => ({ name: item.name, created: item.btime || 0, modified: item.modificationTime || item.mtime || 0,
        width: item.width || 0, height: item.height || 0, duration: item.duration || 0, size: item.size || 0, tags: (item.tags || []).join(",") }[mode]);
    return result.sort((a, b) => ((mode === "name" || mode === "tags") ? naturalCompare(value(a), value(b)) : value(a) - value(b)) * (state.descending ? -1 : 1));
}
export function parseState(raw, fallback = {}) {
    try { const state = JSON.parse(raw); if (state?.version === 1) return state; } catch { /* show recoverable defaults */ }
    return { version: 1, ...fallback };
}
export function catalogKey(state) { return JSON.stringify([state.host, state.token, state.folder_ids || state.folder_id, state.folder_count || 1, state.types || ["image"], state.limit, !!state.include_children, state.library_key,
    state.video_fps, state.video_start_seconds, state.video_max_seconds, state.video_max_edge, state.audio_start_seconds, state.audio_max_seconds]); }
export function validCatalog(state) {
    const folders = Array.isArray(state.folder_ids) ? state.folder_ids.slice(0, state.folder_count || 1) : [state.folder_id];
    return folders.length === (state.folder_count || 1) && folders.every(Boolean) && (!state.types || state.types.length > 0)
        && Number.isInteger(state.limit) && state.limit >= 1 && state.limit <= 500;
}
export function canSearch(state, loadedKey, busy = false) {
    return !busy && validCatalog(state) && loadedKey === catalogKey(state);
}

// Workflow preview metadata contains no pixel data, credentials, or original
// Eagle paths. Each node carries its own cache, so node IDs may be reused by
// other workflows without sharing a previous execution's selection.
export function previewConfigKey(state) { return catalogKey({ ...state, token: "" }); }
export function previewSelectionKey(state) {
    return JSON.stringify([state.selection_mode || "manual", state.manual_query || "", state.query_text ?? null,
        state.match_mode || "exact", state.selected_ids || [], state.locked?.snapshot_id || null]);
}
export function publicPreview(item) {
    if (!item || typeof item !== "object" || typeof item.id !== "string") return null;
    const result = {};
    for (const key of ["id", "name", "ext", "media_type"]) if (typeof item[key] === "string") result[key] = item[key].slice(0, 4096);
    for (const key of ["width", "height", "duration", "size", "btime", "mtime", "modificationTime"]) if (Number.isFinite(item[key])) result[key] = item[key];
    if (Array.isArray(item.tags)) result.tags = item.tags.filter(tag => typeof tag === "string").slice(0, 200).map(tag => tag.slice(0, 2048));
    if (item.preview && typeof item.preview.filename === "string" && !/[\\/:]/.test(item.preview.filename)
        && ["temp", "output", "input"].includes(item.preview.type)) {
        const subfolder = typeof item.preview.subfolder === "string" ? item.preview.subfolder : "";
        if (!subfolder.startsWith("/") && !subfolder.includes("..") && !subfolder.includes(":")) {
            result.preview = { filename: item.preview.filename.slice(0, 512), subfolder: subfolder.slice(0, 512), type: item.preview.type };
        }
    }
    if (typeof item.media_url === "string" && /^\/eagle_assets\/media\/[a-f0-9]{32}$/.test(item.media_url)) result.media_url = item.media_url;
    if (typeof item.model_url === "string" && /^\/eagle_assets\/model\/[a-f0-9]{32}\/[^?#]+$/.test(item.model_url)) result.model_url = item.model_url;
    return result;
}
export function makePreviewCache(state, items, executionItems) {
    return { version: 1, config_key: previewConfigKey(state), selection_key: previewSelectionKey(state), timestamp: Date.now(),
        items: items.slice(0, 500).map(publicPreview).filter(Boolean),
        execution_ids: Array.isArray(executionItems) ? executionItems.map(item => item.id).filter(id => typeof id === "string").slice(0, 500) : null };
}
export function readPreviewCache(cache, state) {
    if (!cache || cache.version !== 1 || cache.config_key !== previewConfigKey(state)
        || cache.selection_key !== previewSelectionKey(state) || !Array.isArray(cache.items)) return null;
    const items = cache.items.slice(0, 500).map(publicPreview).filter(Boolean), lookup = new Map(items.map(item => [item.id, item]));
    return { items, executionItems: Array.isArray(cache.execution_ids) ? cache.execution_ids.map(id => lookup.get(id)).filter(Boolean) : null };
}

// Export previews are file references, never pixel data or connection secrets.
// They live on the serialized node rather than in a global map keyed by node ID.
export function exportPreview(item) {
    if (!item || typeof item !== "object" || typeof item.filename !== "string"
        || /[\\/:]/.test(item.filename) || !["temp", "output"].includes(item.type)) return null;
    const subfolder = typeof item.subfolder === "string" ? item.subfolder : "";
    if (/^(?:[\\/]|[a-z]:)/i.test(subfolder) || subfolder.split(/[\\/]/).includes("..")) return null;
    const result = { filename: item.filename, subfolder, type: item.type };
    for (const key of ["name", "ext", "media_type", "annotation", "eagle_id", "library_key", "eagle_folder_id", "eagle_ext"]) {
        if (typeof item[key] === "string") result[key] = item[key];
    }
    if (item.eagle_saved === true) result.eagle_saved = true;
    if (Array.isArray(item.eagle_exclude_ids)) result.eagle_exclude_ids = item.eagle_exclude_ids.filter(id => typeof id === "string");
    const safe = publicPreview({ ...item, id: "export" });
    if (safe?.preview) result.preview = safe.preview;
    // Model bundles need their registered relative resource URLs. Other media
    // uses /view file descriptors so it survives the media registry's expiry.
    if (item.media_type === "model" && safe?.model_url) result.model_url = safe.model_url;
    return result;
}
