const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const path = require('node:path'), assert = require('node:assert/strict');
const reproduce=process.argv.includes('--reproduce');
const server=spawn(process.env.VC_PYTHON || 'python',[path.join(__dirname,'ui_server.py')],{stdio:['pipe','pipe','pipe'],windowsHide:true});
let diagnostics='';server.stderr.on('data',chunk=>diagnostics+=chunk.toString());
const ready=new Promise((resolve,reject)=>{let output='';const timeout=setTimeout(()=>reject(new Error('Fixture timeout '+diagnostics)),45000);server.stdout.on('data',chunk=>{output+=chunk;const line=output.split('\n')[0];try{const data=JSON.parse(line);clearTimeout(timeout);resolve(data.host)}catch{}});server.on('exit',code=>{clearTimeout(timeout);reject(new Error('Fixture exited '+code+' '+diagnostics))})});
(async()=>{
 let browser;
 try{
  const host=await ready;browser=await chromium.launch({headless:true,...(process.env.VC_BROWSER_PATH?{executablePath:process.env.VC_BROWSER_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1240,height:1400}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(host+'/tests/workflow_switch_harness.html');await page.waitForFunction(()=>globalThis.importNode?.eagleAssetsEditor && !importNode.eagleAssetsEditor.busy);
  const importer=page.locator('#switch-import');
  let stats=await (await fetch(host+'/tests/stats')).json();assert.equal(stats.counts['item/list']||0,0,'blank workflow never scans images');
  await importer.getByLabel('Eagle 目录',{exact:true}).selectOption('assets');await importer.getByLabel('包含子目录').check();await importer.getByRole('button',{name:'加载图片',exact:true}).click();
  await page.waitForFunction(()=>importNode.eagleAssetsEditor.items.length===5 && !importNode.eagleAssetsEditor.busy);
  for(const id of ['asset2','asset0','asset1'])await importer.locator('[data-id='+id+']').click();
  await page.waitForFunction(()=>sortNode.eagleAssetsEditor.items.length===3);const sorter=page.locator('#sort-image');
  await sorter.getByRole('button',{name:'手动点击排序',exact:true}).click();await sorter.locator('[data-id=asset1]').click();await sorter.locator('[data-id=asset0]').click();
  const before=await page.evaluate(()=>({items:importNode.eagleAssetsEditor.items.map(item=>item.id),selected:importNode.eagleAssetsEditor.outputItems().map(item=>item.id),sorted:sortNode.eagleAssetsEditor.outputItems().map(item=>item.id)}));
  await page.evaluate(async()=>{globalThis.savedA=serializeWorkflow();globalThis.previousImport=importNode;await mountWorkflow(blankWorkflow('EagleAssetImport','B'));await mountWorkflow(savedA)});
  assert.equal(await page.evaluate(()=>previousImport===importNode),false,'switching reconstructs actual node instances');
  if(reproduce){
   await page.waitForTimeout(1200);
   const after=await page.evaluate(()=>({items:importNode.eagleAssetsEditor.items.map(item=>item.id),selected:importNode.eagleAssetsEditor.outputItems().map(item=>item.id),sorted:sortNode.eagleAssetsEditor.outputItems().map(item=>item.id),settings:JSON.parse(importNode.widgets[0].value)}));
   console.log(JSON.stringify({before,after,newNode:true},null,2));assert.deepEqual(after.items,before.items,'loaded gallery must survive serialized workflow destruction/reconstruction');
  }
  await page.waitForFunction(()=>importNode.eagleAssetsEditor.items.length===5 && sortNode.eagleAssetsEditor.items.length===3,{},{timeout:5000});
  assert.deepEqual(await page.evaluate(()=>importNode.eagleAssetsEditor.outputItems().map(item=>item.id)),before.selected);
  assert.deepEqual(await page.evaluate(()=>sortNode.eagleAssetsEditor.outputItems().map(item=>item.id)),before.sorted);
  // A separate workflow may reuse the same numeric node IDs, with different folders.
  await page.evaluate(async()=>{savedA=serializeWorkflow();await mountWorkflow(blankWorkflow('EagleAssetImport','B'))});
  await page.waitForFunction(()=>!importNode.eagleAssetsEditor.busy);
  await importer.getByLabel('Eagle 目录',{exact:true}).selectOption('actors');
  stats=await (await fetch(host+'/tests/stats')).json();const configuredBefore=stats.counts['item/list'];
  await page.evaluate(async()=>{globalThis.configuredUnloaded=serializeWorkflow();await mountWorkflow(blankWorkflow());await mountWorkflow(configuredUnloaded)});
  await page.waitForFunction(()=>!importNode.eagleAssetsEditor.busy);await page.waitForTimeout(300);
  stats=await (await fetch(host+'/tests/stats')).json();assert.equal(stats.counts['item/list'],configuredBefore,'configured but never loaded workflow does not trigger its first image scan on restore');
  assert.equal(await importer.locator('.ea-card').count(),0);
  await importer.getByRole('button',{name:'加载图片',exact:true}).click();await page.waitForFunction(()=>importNode.eagleAssetsEditor.items.length===1 && !importNode.eagleAssetsEditor.busy);
  await importer.locator('[data-id=asset3]').click();await page.waitForFunction(()=>sortNode.eagleAssetsEditor.items.length===1);
  await page.evaluate(async()=>{globalThis.savedB=serializeWorkflow();await mountWorkflow(savedA)});
  await page.waitForFunction(()=>!importNode.eagleAssetsEditor.busy && importNode.eagleAssetsEditor.items.length===5 && sortNode.eagleAssetsEditor.items.length===3);
  assert.deepEqual(await page.evaluate(()=>sortNode.eagleAssetsEditor.outputItems().map(item=>item.id)),before.sorted);
  await page.evaluate(async()=>{await mountWorkflow(savedB)});
  await page.waitForFunction(()=>!importNode.eagleAssetsEditor.busy && importNode.eagleAssetsEditor.items.length===1 && sortNode.eagleAssetsEditor.items.length===1);
  assert.deepEqual(await page.evaluate(()=>importNode.eagleAssetsEditor.items.map(item=>item.id)),['asset3']);
  // Old workflows predate preview_loaded. Their valid settings remain compatible.
  await page.evaluate(async()=>{const old=JSON.parse(JSON.stringify(savedA));const state=JSON.parse(old.nodes[0].widgets[0].value);delete state.preview_loaded;old.nodes[0].widgets[0].value=JSON.stringify(state);old.nodes[0].properties={};await mountWorkflow(old)});
  await page.waitForFunction(()=>!importNode.eagleAssetsEditor.busy && importNode.eagleAssetsEditor.items.length===5 && sortNode.eagleAssetsEditor.items.length===3);
  // Restore every typed sorting branch and the exact external-query execution selection.
  await page.evaluate(async()=>{await mountWorkflow(blankWorkflow('EagleMediaImport','Media'))});await page.waitForFunction(()=>!importNode.eagleAssetsEditor.busy);
  await importer.getByLabel('Eagle 目录数量',{exact:true}).fill('2');await importer.getByLabel('Eagle 目录 1',{exact:true}).selectOption('media_mix');await importer.getByLabel('Eagle 目录 2',{exact:true}).selectOption('media_extra');
  await importer.locator('[data-action=type-all]').click();await page.waitForFunction(()=>!importNode.eagleAssetsEditor.busy && importNode.eagleAssetsEditor.items.length===7);
  await importer.getByLabel('资产检索文字',{exact:true}).fill('clip/clip2/sound/sound2/model/model2/picture');await importer.getByRole('button',{name:'检索并标记',exact:true}).click();
  await page.waitForFunction(()=>testNodes[2].eagleAssetsEditor.items.length===1 && testNodes[3].eagleAssetsEditor.items.length===2 && testNodes[4].eagleAssetsEditor.items.length===2 && testNodes[5].eagleAssetsEditor.items.length===2);
  for(const [type,id] of [['video','media_video2'],['audio','media_audio2'],['model','media_model2']]){const target=page.locator('#sort-'+type);await target.getByRole('button',{name:'手动点击排序',exact:true}).click();await target.locator('[data-id='+id+'] .ea-name').click()}
  const mediaBefore=await page.evaluate(()=>Object.values(testNodes).filter(node=>node.type.endsWith('Sort')).map(node=>node.eagleAssetsEditor.outputItems().map(item=>item.id)));
  await page.evaluate(async()=>{globalThis.savedMedia=serializeWorkflow();await mountWorkflow(savedB);await mountWorkflow(savedMedia)});
  await page.waitForFunction(()=>!importNode.eagleAssetsEditor.busy && importNode.eagleAssetsEditor.items.length===7 && testNodes[3].eagleAssetsEditor.items.length===2);
  assert.deepEqual(await page.evaluate(()=>Object.values(testNodes).filter(node=>node.type.endsWith('Sort')).map(node=>node.eagleAssetsEditor.outputItems().map(item=>item.id))),mediaBefore);
  const raw=await page.evaluate(()=>importNode.widgets[0].value);
  const executed=await (await fetch(host+'/tests/run-media-import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settings:raw,query:'clip2/clip/sound'})})).json();
  await page.evaluate(ui=>importNode.onExecuted(ui),executed.ui);await page.waitForFunction(()=>testNodes[2].eagleAssetsEditor.items.length===0 && testNodes[3].eagleAssetsEditor.items.length===2 && testNodes[4].eagleAssetsEditor.items.length===1 && testNodes[5].eagleAssetsEditor.items.length===0);
  await page.evaluate(async()=>{savedMedia=serializeWorkflow();await mountWorkflow(savedB);await mountWorkflow(savedMedia)});
  await page.waitForFunction(()=>!importNode.eagleAssetsEditor.busy && testNodes[2].eagleAssetsEditor.items.length===0 && testNodes[3].eagleAssetsEditor.items.length===2 && testNodes[4].eagleAssetsEditor.items.length===1 && testNodes[5].eagleAssetsEditor.items.length===0);
  assert.deepEqual(await page.evaluate(()=>importNode.eagleAssetsEditor.outputItems().map(item=>item.id)),['media_video2','media_video','media_audio']);
  await importer.getByRole('button',{name:'锁定输出',exact:true}).click();await page.waitForFunction(()=>importNode.eagleAssetsEditor.state.locked && !importNode.eagleAssetsEditor.busy);
  const locked=await page.evaluate(()=>importNode.eagleAssetsEditor.state.locked);
  await page.evaluate(async()=>{savedMedia=serializeWorkflow();await mountWorkflow(savedB);await mountWorkflow(savedMedia)});
  await page.waitForFunction(()=>!importNode.eagleAssetsEditor.busy && importNode.eagleAssetsEditor.lockedItems.length===3 && testNodes[3].eagleAssetsEditor.items.length===2 && testNodes[4].eagleAssetsEditor.items.length===1);
  assert.deepEqual(await page.evaluate(()=>importNode.eagleAssetsEditor.state.locked),locked);
  // Hold a real old response across destruction, then deliver poison data to that retired editor.
  await page.evaluate(async()=>{await mountWorkflow(savedA)});await page.waitForFunction(()=>!importNode.eagleAssetsEditor.busy && importNode.eagleAssetsEditor.items.length===5);
  let capturedResolve,releaseResolve,fulfilledResolve;const captured=new Promise(resolve=>capturedResolve=resolve),release=new Promise(resolve=>releaseResolve=resolve),fulfilled=new Promise(resolve=>fulfilledResolve=resolve);let hold=true;
  await page.route('**/eagle_assets/catalog',async route=>{
   const body=JSON.parse(route.request().postData()||'{}'),state=typeof body.settings==='string'?JSON.parse(body.settings):body.settings;
   if(hold && state?.folder_id==='assets'){
    hold=false;const response=await route.fetch();const data=await response.json();data.items=[{id:'stale-poison',name:'retired response',ext:'png',media_type:'image',width:1,height:1}];capturedResolve();await release;await route.fulfill({response,json:data});fulfilledResolve();
   }else await route.continue();
  });
  await page.evaluate(()=>{importNode.eagleAssetsEditor.action('refresh')});await captured;
  await page.evaluate(async()=>{await mountWorkflow(savedB)});await page.waitForFunction(()=>!importNode.eagleAssetsEditor.busy && importNode.eagleAssetsEditor.items.length===1);
  releaseResolve();await fulfilled;await page.waitForTimeout(300);
  assert.deepEqual(await page.evaluate(()=>importNode.eagleAssetsEditor.items.map(item=>item.id)),['asset3']);
  await page.evaluate(async()=>{await mountWorkflow(savedA)});
  assert.ok(!(await page.evaluate(()=>importNode.eagleAssetsEditor.items.map(item=>item.id))).includes('stale-poison'),'retired responses cannot update serialized workflow preview properties');
  await page.waitForFunction(()=>!importNode.eagleAssetsEditor.busy && importNode.eagleAssetsEditor.items.length===5 && sortNode.eagleAssetsEditor.items.length===3);
  assert.deepEqual(await page.evaluate(()=>sortNode.eagleAssetsEditor.outputItems().map(item=>item.id)),before.sorted);
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('WORKFLOW SWITCH UI PASS: real node destruction/widget+property serialization/reconstruction, legacy image and all media previews, manual selection/order, external execution selection, locked snapshot identity, initially blank/configured-unloaded gating, old-workflow compatibility, different-folder isolation, and stale response suppression.');
  await page.evaluate(()=>Object.values(testNodes).forEach(node=>node.onRemoved?.()));
 }finally{if(browser)await browser.close();server.stdin.end('\n');if(server.exitCode===null)await new Promise(resolve=>server.once('exit',resolve));}
})().catch(error=>{console.error(error,diagnostics);process.exitCode=1});
