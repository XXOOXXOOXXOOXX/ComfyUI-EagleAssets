const { chromium } = require('playwright'), { spawn } = require('node:child_process');
const assert = require('node:assert/strict'), path = require('node:path');
const server = spawn(process.env.VC_PYTHON || 'python', [path.join(__dirname, 'studio_fixture.py')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let diagnostics = ''; server.stderr.on('data', data => diagnostics += data);
const ready = new Promise((resolve, reject) => { let output = ''; const timer = setTimeout(() => reject(Error(diagnostics)), 45000); server.stdout.on('data', data => { output += data; if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.split('\n')[0]).host); } }); server.on('exit', code => { clearTimeout(timer); reject(Error('Fixture exited ' + code + diagnostics)); }); });
(async () => {
  let browser;
  try {
    const host = await ready;
    browser = await chromium.launch({ headless: true, executablePath: process.env.VC_BROWSER_PATH });
    const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } }), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(host + '/tests/studio_ui_harness.html'); await page.waitForFunction(() => globalThis.studioHarnessReady && !importNode.eagleAssetsEditor.busy);
    await page.evaluate(() => {
      const node = addImageBridge(); if (node.inputs.length !== 1 || node.widgets.some(w => w.options?.serialize !== false)) throw Error('Initial node must have only one IMAGE input and its preview');
      for (let index = 0; index < 70; index++) { node.inputs[index].link = 1000 + index; node.graph.links[1000 + index] = { origin_id: 200 + index, origin_slot: 0 }; node.onConnectionsChange(1, index, true); }
      if (node.inputs.length !== 71) throw Error('Inputs must grow beyond fixed limits');
      for (let index = 69; index >= 3; index--) { node.inputs[index].link = null; node.onConnectionsChange(1, index, false); }
      if (node.inputs.length !== 4) throw Error('Keep one spare trailing socket');
    });
    const published = await (await fetch(host + '/tests/run-image-bridge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image_3: [0, 0, 1], image_1: [1, 0, 0], image_2: [0, 1, 0] }) })).json();
    await page.evaluate(async ui => {
      imageBridge.onExecuted(ui);
      const studio = OllamaStudioUI;
      if (studio.imageRefs.length) throw Error('Z starts disabled');
      await studio.action('image-bridge');
      if (studio.imageRefs.length !== 3 || studio.prefs.eagle_enabled) throw Error('Z controls direct images independently of Eagle toggle');
      const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8; const ctx = canvas.getContext('2d'); ctx.fillStyle = 'yellow'; ctx.fillRect(0, 0, 8, 8);
      const blob = await new Promise(resolve => canvas.toBlob(resolve)); await studio.uploadFiles([new File([blob], 'drag-first.png', { type: 'image/png' })]);
      const editor = importNode.eagleAssetsEditor; editor.state.folder_id = 'media_mix'; editor.state.folder_ids = ['media_mix']; editor.state.types = ['image']; editor.invalidate(); editor.persist(); await editor.load();
      bridgeNode.eagleAssetsEditor.state.selected_ids = ['media_image']; bridgeNode.eagleAssetsEditor.persist();
      studio.prefs.eagle_enabled = true; studio.syncEagle();
    }, published.ui);
    const sources = await page.locator('.os-attachments .os-attachment').evaluateAll(cards => cards.map(c => c.dataset.source));
    assert.deepEqual(sources, ['上传', '图片直连', '图片直连', '图片直连', 'Eagle']);
    assert.deepEqual(await page.evaluate(() => OllamaStudioUI.imageRefs.map(i => i.item_id)), ['image_1_1', 'image_2_1', 'image_3_1']);
    // Cache belongs to this serialized node; removing or disconnecting it retracts its images.
    await page.evaluate(() => {
      globalThis.savedImageNode = { properties: JSON.parse(JSON.stringify(imageBridge.properties)), inputs: JSON.parse(JSON.stringify(imageBridge.inputs)) };
      imageBridge.onRemoved(); delete testNodes[100];
      if (EagleAssetsStudioBridge.getImageSelection().length) throw Error('Removed bridge leaked images');
      const node = addImageBridge(); node.inputs = savedImageNode.inputs; node.properties = savedImageNode.properties; node.onConfigure();
    });
    await page.waitForFunction(() => OllamaStudioUI.imageRefs.length === 3);
    await page.getByLabel('输入消息', { exact: true }).fill('按素材顺序分析'); await page.locator('[data-action=send]').click();
    await page.waitForFunction(() => !OllamaStudioUI.busy && OllamaStudioUI.conversation.messages.length >= 2);
    const stats = await (await fetch(host + '/tests/studio-stats')).json(); assert.equal(stats.ollama_calls.at(-1).messages.at(-1).images.length, 5);
    const user = await page.evaluate(() => OllamaStudioUI.conversation.messages.find(m => m.role === 'user'));
    assert.equal(user.attachments[0].name, 'drag-first.png'); assert.deepEqual(user.attachments.slice(1).map(a => a.metadata.source_ref.item_id), ['image_1_1', 'image_2_1', 'image_3_1', 'media_image']);
    await page.evaluate(() => { imageBridge.inputs[1].link = null; imageBridge.onConnectionsChange(1, 1, false); });
    assert.equal(await page.evaluate(() => OllamaStudioUI.imageRefs.length), 0, 'rewiring clears stale published images until rerun');
    assert.deepEqual(errors, []);
    console.log('IMAGE STUDIO UI PASS: 70 dynamic inputs, one spare socket, ordered live references, upload/direct/Eagle display and real chat order, workflow restoration and stale-connection invalidation.');
    await page.evaluate(() => { OllamaStudioUI.destroy(); Object.values(testNodes).forEach(n => n.onRemoved?.()); });
  } finally { if (browser) await browser.close(); server.stdin.end('\n'); if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve)); }
})().catch(error => { console.error(error, diagnostics); process.exitCode = 1; });
