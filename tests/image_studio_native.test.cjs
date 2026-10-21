const { chromium } = require('playwright');
const assert = require('node:assert/strict'), path = require('node:path');
const HOST = 'http://127.0.0.1:8198';
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.VC_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } }), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(HOST); await page.waitForFunction(() => globalThis.comfyAPI?.app?.app?.isGraphReady && comfyAPI.app.app.vueAppReady && LiteGraph.registered_node_types.EagleImageStudioBridge, {}, { timeout: 60000 });
    await page.waitForTimeout(1500);
    await page.evaluate(async () => {
      const { app } = await import('/scripts/app.js'); app.graph.clear();
      globalThis.source = LiteGraph.createNode('LoadImage'); app.graph.add(source); source.widgets.find(w => w.name === 'image').value = 'eagle_preview_regression.png'; source.pos = [0, 0];
      globalThis.bridge = LiteGraph.createNode('EagleImageStudioBridge'); app.graph.add(bridge); bridge.pos = [400, 0];
      if (bridge.inputs.length !== 1 || bridge.widgets?.some(w => w.options?.serialize !== false) || bridge.outputs?.length) throw Error('Must have only image inputs and a preview');
      for (let index = 0; index < 70; index++) source.connect(0, bridge, index);
      if (bridge.inputs.length !== 71) throw Error('Expected one spare input after 70 connections');
      app.canvas.ds.scale = .5; app.canvas.centerOnNode(bridge); app.canvas.setDirty(true, true);
    });
    await page.waitForFunction(() => EagleAssetsStudioBridge.getImageSelection().length === 70, {}, { timeout: 30000 });
    assert.equal(await page.evaluate(() => bridge.eagleImageStudioBridge.root.querySelectorAll('.ea-card[data-selected=true]').length), 70, 'all images preview automatically before queueing');
    await page.evaluate(() => bridge.eagleImageStudioBridge.root.querySelector('[data-id=image_1_1]').click());
    assert.equal(await page.evaluate(() => EagleAssetsStudioBridge.getImageSelection().length), 69);
    await page.evaluate(() => bridge.eagleImageStudioBridge.root.querySelector('[data-id=image_1_1]').click());
    const queued = await page.evaluate(async () => {
      const { app } = await import('/scripts/app.js'), { api } = await import('/scripts/api.js'); const prompt = await app.graphToPrompt();
      if (Object.values(prompt.output).some(n => !['LoadImage', 'EagleImageStudioBridge'].includes(n.class_type))) throw Error('Unexpected graph');
      if (Object.keys(prompt.output[bridge.id].inputs).length !== 70) throw Error('Dynamic input serialization lost ports');
      return api.queuePrompt(0, prompt);
    });
    let history;
    for (let i = 0; i < 150; i++) { const records = await (await fetch(HOST + '/history/' + queued.prompt_id)).json(); if (records[queued.prompt_id]) { history = records[queued.prompt_id]; break; } await new Promise(resolve => setTimeout(resolve, 200)); }
    assert.ok(history); assert.equal(history.status.status_str, 'success', JSON.stringify(history.status));
    await page.waitForFunction(() => EagleAssetsStudioBridge.getImageSelection().length === 70);
    assert.deepEqual(await page.evaluate(() => EagleAssetsStudioBridge.getImageSelection().map(i => i.item_id)), Array.from({ length: 70 }, (_, i) => `image_${i + 1}_1`));
    const restored = await page.evaluate(async () => {
      const { app } = await import('/scripts/app.js'); const saved = app.graph.serialize(), id = bridge.id;
      await app.loadGraphData({ version: .4, nodes: [], links: [], groups: [], config: {}, extra: {} });
      if (EagleAssetsStudioBridge.getImageSelection().length) throw Error('Stale workflow references');
      await app.loadGraphData(saved); globalThis.bridge = app.graph.getNodeById(id);
      return { inputs: bridge.inputs.length, items: EagleAssetsStudioBridge.getImageSelection().length };
    });
    assert.equal(restored.inputs, 71); assert.equal(restored.items, 70);
    await page.waitForTimeout(500); assert.equal(await page.evaluate(() => EagleAssetsStudioBridge.getImageSelection().length), 70);
    await page.evaluate(() => { for (let i = 69; i >= 0; i--) bridge.disconnectInput(i); });
    assert.equal(await page.evaluate(() => bridge.inputs.length), 1); assert.equal(await page.evaluate(() => EagleAssetsStudioBridge.getImageSelection().length), 0);
    assert.deepEqual(errors, []);
    console.log('NATIVE IMAGE BRIDGE PASS: port-only schema, 70 real IMAGE connections/execution, numeric ordering, workflow restore and disconnect cleanup.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
