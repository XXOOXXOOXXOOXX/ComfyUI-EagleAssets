const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const path=require('node:path'),assert=require('node:assert/strict');
const server=spawn(process.env.VC_PYTHON||'python',[path.join(__dirname,'studio_fixture.py')],{stdio:['pipe','pipe','pipe'],windowsHide:true});
let diagnostics='';server.stderr.on('data',chunk=>diagnostics+=chunk.toString());
const ready=new Promise((resolve,reject)=>{
 let output='';const timer=setTimeout(()=>reject(new Error('Fixture timeout '+diagnostics)),45000);
 server.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n')){clearTimeout(timer);resolve(JSON.parse(output.split('\n')[0]).host)}});
 server.on('exit',code=>{clearTimeout(timer);reject(new Error('Fixture exited '+code+' '+diagnostics))});
});
(async()=>{
 let browser;
 try{
  const host=await ready;
  browser=await chromium.launch({headless:true,...(process.env.VC_BROWSER_PATH?{executablePath:process.env.VC_BROWSER_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1800,height:1100}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(host+'/tests/studio_ui_harness.html');
  await page.waitForFunction(()=>globalThis.studioHarnessReady&&!importNode.eagleAssetsEditor.busy);
  // Simulate old workflow choices and lock through the same UI actions as the user.
  await page.evaluate(async()=>{
   const editor=importNode.eagleAssetsEditor;
   editor.state.folder_id='media_mix';editor.state.folder_ids=['media_mix'];editor.state.types=['image','video','audio','model'];
   editor.invalidate();editor.persist();await editor.load();
   bridgeNode.eagleAssetsEditor.state.selected_ids=['media_video','media_image'];bridgeNode.eagleAssetsEditor.persist();
   editor.clickItem(editor.items.find(item=>item.id==='media_image'));await editor.action('lock');
   await editor.action('refresh');bridgeNode.eagleAssetsEditor.sync();
  });
  const check=async()=>{
   const result=await page.evaluate(()=>({
    ids:bridgeNode.eagleAssetsEditor.items.map(item=>item.id),
    selected:EagleAssetsStudioBridge.getSelection(),sid:importNode.eagleAssetsEditor.state.locked.snapshot_id,
    cid:importNode.eagleAssetsEditor.catalogId,status:bridgeNode.eagleAssetsEditor.root.querySelector('.ea-status').textContent,
   }));
   assert.ok(result.cid,'live preview was refreshed while locked');assert.deepEqual(result.ids,['media_image']);
   assert.deepEqual(result.selected.map(item=>item.item_id),['media_image']);assert.equal(result.selected[0].snapshot_id,result.sid);
   assert.equal(result.selected[0].catalog_id,undefined);assert.match(result.status,/1 个旧选择/);
  };
  await check();
  const saved=await page.evaluate(()=>serializeStudioWorkflow());
  await page.evaluate(async saved=>mountStudioWorkflow(saved),saved);
  await page.waitForFunction(()=>!importNode.eagleAssetsEditor.busy&&importNode.eagleAssetsEditor.catalogId&&importNode.eagleAssetsEditor.lockedItems.length===1);
  await page.evaluate(()=>bridgeNode.eagleAssetsEditor.sync());await check();
  await page.evaluate(async()=>{await importNode.eagleAssetsEditor.action('unlock');bridgeNode.eagleAssetsEditor.sync()});
  assert.equal(await page.evaluate(()=>EagleAssetsStudioBridge.getSelection().length),2);
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('BRIDGE UI PASS: locked snapshot overrides refreshed gallery, stale selection skips, workflow restoration preserves snapshot references, unlock restores live catalog. Mock Eagle only.');
 }finally{
  if(browser)await browser.close();server.stdin.end('\n');if(server.exitCode===null)await new Promise(resolve=>server.once('exit',resolve));
 }
})().catch(error=>{console.error(error,diagnostics);process.exitCode=1});
