// Run with tests/start_native.py from DesktopBridge and the three synthetic
// eagle_preview_regression files in its isolated input directory.
const { chromium } = require('playwright');
const assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs');
const HOST = 'http://127.0.0.1:8198';
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'], executablePath: process.env.VC_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1800, height: 1150 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/eagle_assets/connect', route => route.fulfill({ json: { ok: true, library_key: 'fixture', library_name: 'Fixture', folders: [] } }));
    await page.goto(HOST);
    await page.waitForFunction(() => globalThis.comfyAPI?.app?.app?.vueAppReady && comfyAPI.app.app.isGraphReady && comfyAPI.app.app.canvas?.canvas && globalThis.LiteGraph?.registered_node_types?.EagleAssetExport, {}, { timeout: 60000 });
    await page.waitForTimeout(1500);
    console.log('Native ready');
    await page.evaluate(async () => {
      const { app } = await import('/scripts/app.js'); app.graph.clear();
      const add = type => { const node = LiteGraph.createNode(type); app.graph.add(node); return node; };
      const image = add('LoadImage'); image.widgets.find(w => w.name === 'image').value = 'eagle_preview_regression.png';
      const audio = add('LoadAudio'); audio.widgets.find(w => w.name === 'audio').value = 'eagle_preview_regression.wav';
      globalThis.exports = ['EagleAssetExport', 'EagleAssetExport', 'EagleAudioExport', 'EagleVideoExport', 'EagleModelExport'].map((type, index) => {
        const node = add(type); node.pos = [index * 600, 200];
        node.widgets.find(w => w.name === 'filename_prefix').value = 'PreviewRegression/' + index;
        node.eagleAssetsEditor.state.save_output = index !== 0;
        node.eagleAssetsEditor.state.save_eagle = false; node.eagleAssetsEditor.persist();
        return node;
      });
      image.connect(0, exports[0], 0); image.connect(0, exports[1], 0);
      audio.connect(0, exports[2], exports[2].inputs.findIndex(i => i.name === 'audio'));
      image.connect(0, exports[3], exports[3].inputs.findIndex(i => i.name === 'frames'));
      globalThis.exportIds = exports.map(n => n.id);
      app.canvas.ds.scale = .7; app.canvas.centerOnNode(exports[0]);
    });
    const queued = await page.evaluate(async () => {
      const { app } = await import('/scripts/app.js'), { api } = await import('/scripts/api.js');
      const prompt = await app.graphToPrompt();
      if (Object.values(prompt.output).some(n => !['LoadImage', 'LoadAudio', 'EagleAssetExport', 'EagleAudioExport', 'EagleVideoExport', 'EagleModelExport'].includes(n.class_type))) throw Error('Unexpected graph');
      prompt.output[exports[4].id].inputs.path = 'I:/codex/comfyui/.desktop-bridge-test/native/input/eagle_preview_regression.obj';
      return api.queuePrompt(0, prompt);
    });
    let history;
    for (let i = 0; i < 150; i++) { const records = await (await fetch(HOST + '/history/' + queued.prompt_id)).json(); if (records[queued.prompt_id]) { history = records[queued.prompt_id]; break; } await new Promise(resolve => setTimeout(resolve, 200)); }
    assert.ok(history); assert.equal(history.status.status_str, 'success', JSON.stringify(history.status));
    console.log('Queue completed');
    await page.waitForFunction(() => exports.every(n => n.eagleAssetsEditor.previews.length === 1));
    const snapshots = await page.evaluate(async () => {
      const { app } = await import('/scripts/app.js');
      return exports.map(n => ({ id: n.id, previews: JSON.parse(JSON.stringify(n.eagleAssetsEditor.previews)), native: app.nodeOutputs[n.id], properties: JSON.parse(JSON.stringify(n.properties)) }));
    });
    for (const snapshot of snapshots.slice(0, 2)) {
      assert.equal(snapshot.native.images.length, 1, 'shared execution output retains native image descriptors');
      const d = snapshot.native.images[0];
      assert.deepEqual(d, history.outputs[snapshot.id].images[0]);
      const colors = await page.evaluate(async descriptor => {
        const img = new Image(); img.src = '/view?' + new URLSearchParams(descriptor); await img.decode();
        const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
        return [...ctx.getImageData(20, 20, 1, 1).data];
      }, d);
      assert.deepEqual(colors, [56, 123, 161, 255], 'native Assets URL serves the actual colored image');
    }
    // Destruction/reconstruction includes another workflow reusing the same IDs.
    await page.evaluate(async () => {
      const { app } = await import('/scripts/app.js'); globalThis.savedExportWorkflow = app.graph.serialize();
      const other = JSON.parse(JSON.stringify(savedExportWorkflow)); other.nodes.forEach(n => { n.properties = {}; });
      await app.loadGraphData(other);
      if (exportIds.some(id => app.graph.getNodeById(id).eagleAssetsEditor.previews.length)) throw Error('Preview leaked between workflows');
      await app.loadGraphData(savedExportWorkflow); globalThis.exports = exportIds.map(id => app.graph.getNodeById(id));
    });
    await page.waitForFunction(() => exports.every(n => n.eagleAssetsEditor.previews.length === 1));
    await page.waitForFunction(() => exports[4].eagleAssetsEditor.root.querySelector('canvas[data-model-ready=true]'));
    const restored = await page.evaluate(() => exports.map(n => ({ previews: n.eagleAssetsEditor.previews, widgets: n.widgets.map(w => w.name), status: n.eagleAssetsEditor.lastStatus })));
    restored.forEach((n, i) => { assert.equal(n.previews[0].filename, snapshots[i].previews[0].filename); assert.equal(n.status, snapshots[i].properties.eagle_assets_export_preview.status); assert.equal(n.widgets.filter(name => /preview/i.test(name)).length, 0, 'no duplicate native preview widgets'); });
    await page.waitForFunction(() => exports.slice(0, 2).every(n => n.eagleAssetsEditor.root.querySelector('img')?.naturalWidth === 160));
    await page.evaluate(async () => {
      const { app } = await import('/scripts/app.js'); app.canvas.ds.scale = .85; app.canvas.centerOnNode(exports[0]); app.canvas.setDirty(true, true);
    });
    const shots = path.join(__dirname, 'feature-screenshots'); fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, 'native-export-preview-restored.png') });
    // Inspect the actual media-assets sidebar, not a replacement gallery.
    const imageJob = await page.evaluate(async () => {
      const { app } = await import('/scripts/app.js'), { api } = await import('/scripts/api.js');
      const prompt = await app.graphToPrompt();
      prompt.output = Object.fromEntries(Object.entries(prompt.output).filter(([id, n]) => n.class_type === 'LoadImage' || exports.slice(0, 2).some(node => String(node.id) === id)));
      return api.queuePrompt(0, prompt);
    });
    for (let i = 0; i < 100; i++) { const records = await (await fetch(HOST + '/history/' + imageJob.prompt_id)).json(); if (records[imageJob.prompt_id]) break; await new Promise(resolve => setTimeout(resolve, 200)); }
    await page.getByText('资产', { exact: true }).click();
    await page.waitForFunction(id => document.querySelector(`[data-asset-id="${id}"] img`)?.naturalWidth === 160, imageJob.prompt_id);
    const assetColors = await page.locator(`[data-asset-id="${imageJob.prompt_id}"] img`).evaluate(img => {
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 120; const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0); return [...ctx.getImageData(20, 20, 1, 1).data];
    });
    assert.deepEqual(assetColors, [56, 123, 161, 255], 'real Media Assets card displays the image instead of a black thumbnail');
    await page.screenshot({ path: path.join(shots, 'native-export-assets.png') });
    assert.deepEqual(errors, []);
    console.log('NATIVE EXPORT PREVIEW PASS: all four exporters, temp/output image pixels, shared native descriptors, workflow isolation, restored previews/model resources, and no duplicate canvas preview.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
