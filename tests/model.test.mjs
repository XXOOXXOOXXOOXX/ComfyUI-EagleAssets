import test from "node:test";
import assert from "node:assert/strict";
import { mediaCatalogView, matchItems, sortItems, catalogKey, canSearch, outputSelection, itemType, validCatalog, queryTokens, makePreviewCache, readPreviewCache, publicPreview } from "../web/model.js";

test("bridge catalog follows the locked snapshot while live preview refreshes", () => {
    const editor = { state: { locked: { snapshot_id: "snapshot", ids: ["a"] } }, catalogId: "refreshed",
        items: [{id:"b", name:"new"}], lockedItems: [{id:"a", name:"locked", media_url:"snapshot-url"}] };
    assert.deepEqual(mediaCatalogView(editor), {snapshot_id:"snapshot", items:editor.lockedItems});
    editor.lockedItems = [];
    assert.deepEqual(mediaCatalogView(editor), {snapshot_id:"snapshot", items:[]});
    editor.state.locked = null;
    assert.deepEqual(mediaCatalogView(editor), {catalog_id:"refreshed", items:editor.items});
});
const items = [{ id: "a", name: "1", width: 64 }, { id: "b", name: "2", width: 80 }, { id: "c", name: "10", width: 32 }];
test("multi-name search marks all matches in token order without removing catalog entries", () => {
    const result = matchItems(items, "2/1.png/2");
    assert.deepEqual(result.items.map(item => item.id), ["b", "a"]); assert.equal(items.length, 3);
    assert.deepEqual(matchItems(items, "missing").missing, ["missing"]);
});
test("search stays disabled until folder, valid limit and matching catalog are ready; text can exist beforehand", () => {
    const state = { folder_id: "", limit: 20, query_text: "1/2" };
    assert.equal(canSearch(state, catalogKey(state)), false);
    state.folder_id = "assets"; assert.equal(canSearch(state, null), false);
    const key = catalogKey(state); assert.equal(canSearch(state, key), true);
    state.limit = 30; assert.equal(canSearch(state, key), false);
    assert.equal(canSearch(state, catalogKey(state), true), false);
});
test("manual selection order and field sort remain deterministic", () => {
    assert.deepEqual(outputSelection(items, { selection_mode: "manual", selected_ids: ["b", "a"] }).map(item => item.id), ["b", "a"]);
    assert.deepEqual(sortItems(items, { mode: "name", descending: true }).map(item => item.name), ["10", "2", "1"]);
    assert.deepEqual(sortItems(items, { mode: "manual", order: ["b"] }).map(item => item.id), ["b", "a", "c"]);
    assert.deepEqual(sortItems(items, { mode: "width" }).map(item => item.id), ["c", "a", "b"]);
});
test("all multi-directory slots and media types must be ready before a catalog can be searched", () => {
    const state = { folder_count: 5, folder_ids: ["mix", "other", "mix", "other", ""], types: ["image"], limit: 20 };
    assert.equal(validCatalog(state), false);
    assert.equal(canSearch(state, catalogKey(state)), false);
    state.folder_ids[4] = "mix";
    const ready = catalogKey(state);
    assert.equal(canSearch(state, ready), true);
    state.types.push("video");
    assert.equal(canSearch(state, ready), false, "adding a media type requires a matching reload");
    assert.equal(canSearch(state, catalogKey(state)), true);
    state.types = [];
    assert.equal(validCatalog(state), false);
});
test("media filename queries share normalization and preserve multi-asset token order", () => {
    const assets = [{id:"v",name:"clip",ext:"mp4"},{id:"a",name:"sound",ext:"wav"},{id:"m",name:"model",ext:"obj"}];
    assert.deepEqual(queryTokens("clip.mp4/sound.wav/model.obj/clip.mp4"), ["clip","sound","model"]);
    assert.deepEqual(matchItems(assets, "model.obj/clip.mp4/sound.wav").items.map(item=>item.id), ["m","v","a"]);
    assert.deepEqual(assets.map(itemType), ["video","audio","model"]);
    assert.equal(itemType({ext:"png"}), "image");
});
test("video and audio can sort by duration, with deterministic manual click order", () => {
    const assets = [{id:"long",name:"clip2",duration:3}, {id:"short",name:"clip1",duration:2}];
    assert.deepEqual(sortItems(assets, {mode:"duration"}).map(item=>item.id), ["short","long"]);
    assert.deepEqual(sortItems(assets, {mode:"manual",order:["short"]}).map(item=>item.id), ["short","long"]);
});
test("workflow preview caches retain public descriptors and actual execution IDs without credentials or media payloads", () => {
    const state={host:"http://localhost:41595",token:"private-token-value",folder_id:"assets",limit:20,selection_mode:"manual",selected_ids:["a","b"]};
    const raw={id:"a",name:"public asset",ext:"png",media_type:"image",width:64,height:80,tags:["story"],
        token:"private-token-value",path:"C:/private/source.png",_path:"C:/private/original.png",waveform:[0.1,0.2],base64:"private-pixel-payload",catalog_id:"private-session",
        preview:{filename:"thumb.png",subfolder:"",type:"temp",token:"private-preview-token"},media_url:"data:image/png;base64,private-pixel-payload"};
    const other={id:"b",name:"second",ext:"wav",media_type:"audio",media_url:"/eagle_assets/media/"+"a".repeat(32)};
    const cache=makePreviewCache(state,[raw,other],[other,raw]);
    assert.deepEqual(cache.execution_ids,["b","a"]);
    const serialized=JSON.stringify(cache);
    for(const secret of ["private-token-value","C:/private","private-pixel-payload","private-session","private-preview-token","waveform","base64","catalog_id"])
        assert.equal(serialized.includes(secret),false,secret+" must not be persisted in workflow preview metadata");
    assert.deepEqual(publicPreview(raw).preview,{filename:"thumb.png",subfolder:"",type:"temp"});
    const restored=readPreviewCache(JSON.parse(serialized),state);
    assert.deepEqual(restored.items.map(item=>item.id),["a","b"]);
    assert.deepEqual(restored.executionItems.map(item=>item.id),["b","a"]);
    assert.equal(restored.items[1].media_url,other.media_url);
});
test("preview metadata cannot be reused across different catalog or selection configurations", () => {
    const state={host:"http://localhost:41595",folder_count:2,folder_ids:["one","two"],types:["image","video"],limit:20,
        selection_mode:"query",manual_query:"1/2",query_text:"1/2",selected_ids:["a","b"],locked:null};
    const cache=makePreviewCache(state,items,[items[1]]);
    assert.ok(readPreviewCache(cache,state));
    for(const changes of [{host:"http://other-host:41595"},{folder_ids:["three","two"]},{types:["audio"]},{limit:50},
        {selection_mode:"manual"},{manual_query:"3"},{query_text:"new draft"},{selected_ids:["b","a"]},{locked:{snapshot_id:"different-snapshot"}}])
        assert.equal(readPreviewCache(cache,{...state,...changes}),null,"changed configuration must reject a stale preview");
});
test("sort selection filtering outputs only selected assets in click order while retaining the source gallery", () => {
    const selected={mode:"manual",filter_mode:true,selected_ids:["b","a"],order:["b","a"]};
    assert.deepEqual(sortItems(items,selected).map(item=>item.id),["b","a"]);
    assert.equal(items.length,3,"deselected source items remain available for the preview gallery");
    selected.selected_ids=["a"];selected.order=["a"];
    assert.deepEqual(sortItems(items,selected).map(item=>item.id),["a"]);
    selected.selected_ids=[];selected.order=[];
    assert.deepEqual(sortItems(items,selected),[],"clearing selection emits no assets");
});
test("turning off selection filtering preserves legacy all-assets output and supports field sorting", () => {
    assert.deepEqual(sortItems(items,{mode:"manual",filter_mode:false,selected_ids:["b"],order:["b"]}).map(item=>item.id),["b","a","c"]);
    assert.deepEqual(sortItems(items,{mode:"width",filter_mode:true,selected_ids:["a","b"]}).map(item=>item.id),["a","b"]);
    assert.deepEqual(sortItems(items,{mode:"input",filter_mode:true,selected_ids:["missing","a","a"]}).map(item=>item.id),["a"]);
});
