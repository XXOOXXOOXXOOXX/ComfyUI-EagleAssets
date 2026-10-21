import { createRoot, card } from "./editors.js";

export function imageStudioBridge(node, { request, changed, imageURL, readSources = () => ({ key: "", sources: [] }), active = () => true }) {
    let removed = false, configuring = false, syncing = false, revision = 0, observedKey, busy = false, retryAfter = 0, error = "";
    const root = createRoot(`<div class="ea-status" role="status"></div><div class="ea-note">默认全选，点击图片取消 / 恢复引用。加载图片节点可自动读取；生成图片需先执行工作流。OllamaStudio 开启 Z 后自动加入所选图片。</div><div class="ea-grid" aria-label="图片直连预览"></div><div class="ea-error" role="alert"></div>`);
    const signature = () => JSON.stringify((node.inputs || []).filter(input => input.link != null).map(input => {
        const link = node.graph?.links?.get?.(input.link) || node.graph?.links?.[input.link];
        return [input.name, link?.origin_id, link?.origin_slot];
    }));
    const cache = () => node.properties?.eagle_image_studio;
    const disabled = () => new Set(Array.isArray(node.properties.eagle_image_disabled) ? node.properties.eagle_image_disabled : []);
    const selection = () => {
        const value = cache(), excluded = disabled();
        if (busy || !value?.snapshot_id || value.signature !== signature() || (value.source_key != null && value.source_key !== readSources().key)) return [];
        return (value.items || []).filter(item => !excluded.has(item.id)).map(item => ({ ...item, id: `${value.snapshot_id}:${item.id}`, snapshot_id: value.snapshot_id, item_id: item.id, bridge_id: node.id }));
    };
    const render = () => {
        const items = cache()?.signature === signature() ? cache().items || [] : [], excluded = disabled();
        root.querySelector(".ea-status").textContent = busy ? "正在读取连接的图片…" : `预览 ${items.length} 张 · 已选 ${items.filter(item => !excluded.has(item.id)).length} 张`;
        root.querySelector(".ea-error").textContent = error;
        const grid = root.querySelector(".ea-grid"); grid.replaceChildren();
        items.forEach((item, index) => grid.append(card(item, imageURL, index + 1, !excluded.has(item.id), () => {
            const next = disabled(); if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
            node.properties.eagle_image_disabled = [...next]; node.graph?.change?.(); render(); changed();
        })));
        if (!items.length) { const empty = document.createElement("div"); empty.className = "ea-empty"; empty.textContent = "连接加载图片节点后自动预览；其他图片输出在工作流执行后显示。"; grid.append(empty); }
        editor.heightChanged?.();
    };
    const sync = () => {
        if (syncing) return;
        syncing = true;
        try {
            let last = -1;
            (node.inputs || []).forEach((input, index) => { if (input.link != null) last = index; });
            const count = last + 2;
            while ((node.inputs?.length || 0) < count) node.addInput(`image_${node.inputs.length + 1}`, "IMAGE");
            while (node.inputs.length > count) node.removeInput(node.inputs.length - 1);
            node.setDirtyCanvas?.(true, true);
        } finally { syncing = false; }
    };
    const clear = () => { ++revision; busy = false; observedKey = undefined; delete node.properties.eagle_image_studio; render(); changed(); };
    const apply = (value, key) => {
        node.properties.eagle_image_studio = { ...value, signature: signature(), source_key: key };
        observedKey = key; busy = false; error = ""; render(); changed();
    };
    const refresh = async () => {
        if (removed || configuring || !active() || Date.now() < retryAfter) return;
        const live = readSources(); if (live.key === observedKey) return;
        observedKey = live.key;
        const current = ++revision, sig = signature();
        const value = cache(), sources = [...live.sources];
        // Retain generated ports while a different port's LoadImage changes.
        if (value?.signature === sig && value.snapshot_id) for (const slot of live.pending || []) {
            if (value.items?.some(item => item.id.startsWith(`image_${slot}_`))) sources.push({ slot, snapshot_id: value.snapshot_id });
        }
        if (!sources.length) { apply({ items: [] }, live.key); return; }
        busy = true; error = ""; render(); changed();
        try {
            const result = await request("image_studio_preview", { sources });
            if (removed || current !== revision || !active() || sig !== signature() || readSources().key !== live.key) return;
            apply(result, live.key);
        } catch (exception) {
            if (removed || current !== revision) return;
            error = exception.message || "图片读取失败"; retryAfter = Date.now() + 3000; observedKey = undefined;
        } finally { if (!removed && current === revision) { busy = false; render(); changed(); } }
    };
    const configure = node.onConfigure;
    node.onConfigure = function () {
        configuring = true;
        try { configure?.apply(this, arguments); sync(); } finally { configuring = false; }
        const value = cache(), current = ++revision;
        busy = false; observedKey = value?.source_key; render(); changed();
        if (value?.snapshot_id && value.signature === signature()) request("snapshot", { snapshot_id: value.snapshot_id }).then(result => {
            if (removed || current !== revision || cache() !== value) return;
            value.items = result.items; render(); changed();
        }).catch(() => { if (!removed && current === revision) clear(); });
    };
    const connections = node.onConnectionsChange;
    node.onConnectionsChange = function () {
        const result = connections?.apply(this, arguments);
        if (configuring || syncing) return result;
        sync();
        if (cache() && cache().signature !== signature()) clear();
        return result;
    };
    const executed = node.onExecuted;
    node.onExecuted = function (message) {
        const result = executed?.apply(this, arguments), value = message.eagle_image_studio?.[0];
        if (value && !removed) { ++revision; apply(value, readSources().key); }
        return result;
    };
    const dispose = () => { removed = true; ++revision; clearInterval(timer); };
    const remove = node.onRemoved;
    node.onRemoved = function () { dispose(); changed(); return remove?.apply(this, arguments); };
    const editor = { root, selection, refresh, render, dispose };
    node.properties ||= {}; sync(); render();
    const timer = setInterval(refresh, 500);
    return editor;
}
