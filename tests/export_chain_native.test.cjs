const { chromium } = require('playwright'), { spawn } = require('node:child_process');
const path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict');
const HOST = 'http://127.0.0.1:8198';
const server = spawn(process.env.VC_PYTHON || 'python', [path.join(__dirname, 'ui_server.py')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let diagnostics = ''; server.stderr.on('data', data => diagnostics += data.toString());
const ready = new Promise((resolve, reject) => { let text = ''; const timer = setTimeout(() => reject(Error(diagnostics)), 45000); server.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(text.split('\n')[0]).host); } }); server.on('exit', code => { clearTimeout(timer); reject(Error('fixture exited ' + code + ' ' + diagnostics)); }); });
(async () => {
  let browser;
  try {
    const fixture = await ready;
    browser = await chromium.launch({ headless: true, executablePath: process.env.VC_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
    const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } }), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/eagle_assets/connect', route => JSON.parse(route.request().postDataJSON().settings).host === fixture ? route.continue() : route.fulfill({ status: 400, json: { ok: false, error: '只允许测试 Eagle' } }));
    await page.goto(HOST); await page.waitForFunction(() => globalThis.comfyAPI?.app?.app?.vueAppReady && globalThis.LiteGraph?.registered_node_types?.EagleAssetExport && globalThis.comfyAPI?.app?.app?.isGraphReady, {}, { timeout: 60000 });
    await page.waitForTimeout(1500);
    await page.evaluate(async host => {
      const { app } = await import('/scripts/app.js'); app.graph.clear();
      const source = LiteGraph.createNode('DesktopScreenCapture'); app.graph.add(source); source.pos = [0, 0];
      for (const [name, value] of Object.entries({ enabled: false, resize_width: 32, resize_height: 32 })) source.widgets.find(w => w.name === name).value = value;
      const types = ['EagleAssetExport', 'EagleAssetExport', 'EagleVideoExport', 'EagleModelExport'];
      globalThis.chainNodes = types.map((type, index) => { const node = LiteGraph.createNode(type); app.graph.add(node); node.pos = [600 + index * 600, 40]; return node; });
      globalThis.chainIds = chainNodes.map(node => node.id);
      globalThis.targetPort = node => node.inputs.findIndex(input => input.name === 'eagle_target');
      for (let index = 0; index < chainNodes.length; index++) {
        const node = chainNodes[index];
        if (!node.inputs.some(input => input.name === 'eagle_target') || node.outputs[0]?.type !== 'EAGLE_EXPORT_TARGET') throw Error('missing chain ports');
        node.widgets.find(w => w.name === 'filename_prefix').value = 'Chain/' + index;
        node.eagleAssetsEditor.connectionChanged('host', host);
        await node.eagleAssetsEditor.connect();
        node.eagleAssetsEditor.state.folder_id = index ? 'actors' : 'results';
        node.eagleAssetsEditor.state.folder_label = index ? 'Assets / Actors' : 'Results';
        node.eagleAssetsEditor.state.save_eagle = !index;
        node.eagleAssetsEditor.state.save_output = index === 1;
        node.eagleAssetsEditor.state.tags = 'node-' + index;
        node.eagleAssetsEditor.state.annotation = 'annotation-' + index;
        node.eagleAssetsEditor.persist();
        if (index) chainNodes[index - 1].connect(0, node, targetPort(node));
      }
      source.connect(0, chainNodes[0], chainNodes[0].inputs.findIndex(i => i.name === 'images'));
      source.connect(0, chainNodes[1], chainNodes[1].inputs.findIndex(i => i.name === 'images'));
      const audio = LiteGraph.createNode('EagleAudioExport'); app.graph.add(audio);
      if (audio.inputs[targetPort(audio)]?.type !== 'EAGLE_EXPORT_TARGET' || audio.outputs[0]?.name !== 'eagle_target') throw Error('audio chain ports missing');
      app.graph.remove(audio);
      app.canvas.ds.scale = .65; app.canvas.centerOnNode(chainNodes[1]); app.canvas.setDirty(true, true);
    }, fixture);
    const inherited = () => page.evaluate(() => chainNodes.map(node => ({ folder: node.eagleAssetsEditor.folder.value, disabled: node.eagleAssetsEditor.folder.disabled, saved: node.eagleAssetsEditor.state.folder_id, eagle: node.eagleAssetsEditor.root.querySelector('[data-action=eagle]').dataset.on })));
    let values = await inherited(); assert.equal(values[0].disabled, false);
    for (const item of values.slice(1)) { assert.equal(item.folder, 'results'); assert.equal(item.disabled, true); assert.equal(item.saved, 'actors'); assert.equal(item.eagle, 'true'); }
    await page.evaluate(() => { const head = chainNodes[0].eagleAssetsEditor; head.state.folder_id = 'assets'; head.state.folder_label = 'Assets'; head.persist(); });
    assert.ok((await inherited()).every(item => item.folder === 'assets'));
    await page.evaluate(() => chainNodes[1].disconnectInput(targetPort(chainNodes[1])));
    values = await inherited(); assert.equal(values[1].folder, 'actors'); assert.equal(values[1].disabled, false); assert.equal(values[2].folder, 'actors'); assert.equal(values[2].eagle, 'false');
    await page.evaluate(() => { const head = chainNodes[0].eagleAssetsEditor; head.state.folder_id = 'results'; head.state.folder_label = 'Results'; head.persist(); chainNodes[0].connect(0, chainNodes[1], targetPort(chainNodes[1])); });
    const shots = path.join(__dirname, 'feature-screenshots'); fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, 'native-export-chain.png') });
    const queued = await page.evaluate(async () => { const { app } = await import('/scripts/app.js'), { api } = await import('/scripts/api.js'); const prompt = await app.graphToPrompt(); if (Object.values(prompt.output).some(node => !['DesktopScreenCapture', 'EagleAssetExport', 'EagleVideoExport', 'EagleModelExport'].includes(node.class_type))) throw Error('Unexpected model graph'); return api.queuePrompt(0, prompt); });
    let result;
    for (let i = 0; i < 100; i++) { const records = await (await fetch(HOST + '/history/' + queued.prompt_id)).json(); if (records[queued.prompt_id]) { result = records[queued.prompt_id]; break; } await new Promise(resolve => setTimeout(resolve, 200)); }
    assert.ok(result); assert.equal(result.status.status_str, 'success', JSON.stringify(result.status));
    const stats = await (await fetch(fixture + '/tests/stats')).json(); assert.equal(stats.exports, 2, 'two image nodes save with one selected Eagle destination');
    assert.equal(result.outputs[await page.evaluate(() => String(chainNodes[1].id))].eagle_media[0][0].eagle_folder_id, 'results');
    // Simulate serialized old nodes without the newly introduced input/output sockets.
    const restoration = await page.evaluate(async () => {
      const { app } = await import('/scripts/app.js'); const saved = app.graph.serialize(), legacy = structuredClone(saved);
      const removed = new Set(legacy.links.filter(link => link[5] === 'EAGLE_EXPORT_TARGET').map(link => link[0])); legacy.links = legacy.links.filter(link => !removed.has(link[0]));
      for (const node of legacy.nodes) if (node.type.startsWith('Eagle') && node.type.endsWith('Export')) { node.inputs = node.inputs.filter(input => input.name !== 'eagle_target'); node.outputs = []; }
      await app.loadGraphData(legacy);
      const legacyPorts = chainIds.every(id => { const node = app.graph.getNodeById(id); return node.inputs.some(i => i.name === 'eagle_target') && node.outputs[0]?.type === 'EAGLE_EXPORT_TARGET'; });
      await app.loadGraphData(saved); globalThis.chainNodes = chainIds.map(id => app.graph.getNodeById(id));
      return { legacyPorts, inherited: chainNodes[1].eagleAssetsEditor.folder.value, disabled: chainNodes[1].eagleAssetsEditor.folder.disabled };
    });
    assert.ok(restoration.legacyPorts); assert.equal(restoration.inherited, 'results'); assert.equal(restoration.disabled, true);
    assert.deepEqual(errors, []); console.log('NATIVE EXPORT CHAIN PASS: four port schemas, live inheritance, independent local settings, unlink restoration, real chained queue, legacy migration and workflow reload.');
  } finally { if (browser) await browser.close(); server.stdin.end('\n'); if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve)); }
})().catch(error => { console.error(error, diagnostics); process.exitCode = 1; });
