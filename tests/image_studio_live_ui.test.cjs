const { chromium } = require('playwright'), { spawn } = require('node:child_process');
const assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs');
const server = spawn(process.env.VC_PYTHON || 'python', [path.join(__dirname, 'studio_fixture.py')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let diagnostics = ''; server.stderr.on('data', d => diagnostics += d);
const ready = new Promise((resolve, reject) => { let output = ''; const timer = setTimeout(() => reject(Error(diagnostics)), 45000); server.stdout.on('data', d => { output += d; if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.split('\n')[0]).host); } }); server.on('exit', code => { clearTimeout(timer); reject(Error('Fixture exited ' + code + diagnostics)); }); });
(async () => {
  let browser;
  try {
    const host = await ready;
    browser = await chromium.launch({ headless: true, executablePath: process.env.VC_BROWSER_PATH });
    const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } }), errors = [], requests = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('request', r => requests.push(r.url()));
    await page.goto(host + '/tests/studio_ui_harness.html'); await page.waitForFunction(() => globalThis.studioHarnessReady && !importNode.eagleAssetsEditor.busy);
    await page.evaluate(() => {
      const node = addImageBridge();
      for (let index = 0; index < 2; index++) {
        testNodes[200 + index] = { id: 200 + index, type: 'LoadImage', widgets: [{ name: 'image', value: index ? 'live-blue.png' : 'live-red.png' }] };
        node.graph.links[1000 + index] = { origin_id: 200 + index, origin_slot: 0 }; node.inputs[index].link = 1000 + index; node.onConnectionsChange(1, index, true);
      }
    });
    await page.waitForFunction(() => imageBridge.eagleImageStudioBridge.root.querySelectorAll('.ea-card').length === 2 && EagleAssetsStudioBridge.getImageSelection().length === 2);
    assert.equal(await page.locator('#image-direct .ea-card[data-selected=true]').count(), 2, 'new images default to selected');
    assert.equal(await page.evaluate(() => OllamaStudioUI.imageRefs.length), 0, 'Z off keeps direct pictures out of composer');
    await page.locator('[data-action=image-bridge]').click();
    assert.equal(await page.locator('[data-action=image-bridge]').getAttribute('data-on'), 'true');
    await page.waitForFunction(() => OllamaStudioUI.imageRefs.length === 2);
    await page.locator('#image-direct [data-id=image_2_1]').click();
    assert.deepEqual(await page.evaluate(() => OllamaStudioUI.imageRefs.map(i => i.item_id)), ['image_1_1']);
    assert.equal(await page.locator('#image-direct [data-id=image_2_1]').getAttribute('data-selected'), 'false');
    await page.evaluate(() => { testNodes[200].widgets[0].value = 'live-blue.png'; });
    await page.waitForFunction(() => OllamaStudioUI.imageRefs.length === 1 && imageBridge.properties.eagle_image_studio.source_key.includes('live-blue.png') && !imageBridge.properties.eagle_image_studio.source_key.includes('live-red.png'));
    const color = await page.locator('#image-direct [data-id=image_1_1] img').evaluate(async image => { await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); return [...ctx.getImageData(5, 5, 1, 1).data]; });
    assert.ok(color[2] > 240 && color[0] < 10, 'changing the LoadImage widget updates the actual preview without running');
    await page.locator('[data-action=image-bridge]').click(); assert.equal(await page.evaluate(() => OllamaStudioUI.imageRefs.length), 0);
    await page.locator('[data-action=image-bridge]').click(); assert.equal(await page.evaluate(() => OllamaStudioUI.imageRefs.length), 1);
    await page.evaluate(() => {
      const saved = { properties: JSON.parse(JSON.stringify(imageBridge.properties)), inputs: JSON.parse(JSON.stringify(imageBridge.inputs)) };
      imageBridge.onRemoved(); delete testNodes[100]; const restored = addImageBridge(); restored.inputs = saved.inputs; restored.properties = saved.properties; restored.onConfigure();
    });
    await page.waitForFunction(() => OllamaStudioUI.imageRefs.length === 1 && imageBridge.eagleImageStudioBridge.root.querySelectorAll('.ea-card').length === 2);
    assert.equal(await page.locator('#image-direct [data-id=image_2_1]').getAttribute('data-selected'), 'false', 'workflow restore keeps exclusions');
    let capturedResolve, releaseResolve, deliveredResolve, held = false;
    const captured = new Promise(resolve => capturedResolve = resolve), release = new Promise(resolve => releaseResolve = resolve), delivered = new Promise(resolve => deliveredResolve = resolve);
    await page.route('**/eagle_assets/image_studio_preview', async route => {
      if (!held && route.request().postData().includes('live-red.png')) {
        held = true; const response = await route.fetch(); capturedResolve(); await release; await route.fulfill({ response }); deliveredResolve();
      } else await route.continue();
    });
    await page.evaluate(() => { testNodes[200].widgets[0].value = 'live-red.png'; }); await captured;
    await page.evaluate(() => { testNodes[200].widgets[0].value = 'live-blue.png'; });
    await page.waitForFunction(() => OllamaStudioUI.imageRefs.length === 1 && !imageBridge.properties.eagle_image_studio.source_key.includes('live-red.png'));
    releaseResolve(); await delivered; await page.waitForTimeout(150);
    assert.ok(!(await page.evaluate(() => imageBridge.properties.eagle_image_studio.source_key)).includes('live-red.png'), 'late old-file responses cannot overwrite the current preview');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ollama-studio.ui.v1')).image_bridge_enabled), true);
    await page.getByLabel('输入消息', { exact: true }).fill('只分析选中的图片'); await page.locator('[data-action=send]').click();
    await page.waitForFunction(() => !OllamaStudioUI.busy && OllamaStudioUI.conversation.messages.length === 2);
    const stats = await (await fetch(host + '/tests/studio-stats')).json(); assert.equal(stats.ollama_calls.at(-1).messages.at(-1).images.length, 1);
    assert.ok(!requests.some(url => /\/prompt(?:\?|$)/.test(url)), 'automatic read must never queue a workflow');
    const shots = path.join(__dirname, 'feature-screenshots'); fs.mkdirSync(shots, { recursive: true });
    await page.locator('#image-direct').screenshot({ path: path.join(shots, 'image-bridge-selection.png') });
    await page.locator('#ollama-studio .os-panel').screenshot({ path: path.join(shots, 'image-bridge-z.png') });
    assert.deepEqual(errors, []);
    console.log('LIVE IMAGE BRIDGE PASS: automatic LoadImage reads without queue, default all selected, exclusions affect actual model inputs, live file changes, independent persisted Z, workflow selection restoration.');
    await page.evaluate(() => { OllamaStudioUI.destroy(); Object.values(testNodes).forEach(n => n.onRemoved?.()); });
  } finally { if (browser) await browser.close(); server.stdin.end('\n'); if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve)); }
})().catch(error => { console.error(error, diagnostics); process.exitCode = 1; });
