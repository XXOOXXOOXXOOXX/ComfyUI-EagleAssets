const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict');
const viewersOnly=process.argv.includes('--viewers-only');
const server=spawn(process.env.VC_PYTHON || 'python',[path.join(__dirname,'ui_server.py')],{stdio:['pipe','pipe','pipe'],windowsHide:true});
let diagnostics='';server.stderr.on('data',chunk=>diagnostics+=chunk.toString());
const ready=new Promise((resolve,reject)=>{let output='';const timeout=setTimeout(()=>reject(new Error('Fixture timeout '+diagnostics)),45000);server.stdout.on('data',chunk=>{output+=chunk;const line=output.split('\n')[0];try{const data=JSON.parse(line);clearTimeout(timeout);resolve(data.host)}catch{}});server.on('exit',code=>{clearTimeout(timeout);reject(new Error('Fixture exited '+code+' '+diagnostics))})});
(async()=>{
 let browser;
 try{
  const host=await ready;
  browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader'],...(process.env.VC_BROWSER_PATH?{executablePath:process.env.VC_BROWSER_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1750,height:1050},deviceScaleFactor:1});const errors=[],responses=[];page.on('pageerror',error=>errors.push(error.message));page.on('response',response=>responses.push({url:response.url(),status:response.status()}));
  await page.goto(host+'/tests/exports_ui_harness.html');
  await page.waitForFunction(()=>globalThis.modelNode?.eagleAssetsEditor && Object.values(testNodes).every(node=>node.eagleAssetsEditor && !node.eagleAssetsEditor.busy));
  const run=async(kind,args={})=>{
   const settings=await page.evaluate(kind=>globalThis[kind+'Node'].widgets.find(widget=>widget.name==='settings').value,kind);
   const response=await fetch(host+'/tests/run-media-export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,settings,...args})});
   const content=await response.text();assert.ok(response.ok,content);
   return JSON.parse(content);
  };
  const visibleModel=async format=>{
   await page.waitForFunction(()=>document.querySelector('#model canvas[data-model-ready=true]'));
   const canvas=page.locator('#model canvas[data-model-ready=true]');const preview=await canvas.screenshot();
   const response=await fetch(host+'/tests/inspect-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image_base64:preview.toString('base64')})});
   const analysis=await response.json();assert.ok(analysis.visible_pixels>300,format+' viewer must render visible geometry, not an empty canvas');
   return canvas;
  };
  for(const kind of ['audio','video','model']){
   const exporter=page.locator('#'+kind);
   await exporter.getByLabel('Eagle 目录',{exact:true}).selectOption('results');
   await exporter.getByLabel('Eagle 标签',{exact:true}).fill('manual-tag');await exporter.getByLabel('Eagle 标签',{exact:true}).blur();
   await exporter.getByLabel('Eagle 注释',{exact:true}).fill('manual annotation');
   for(const [eagle,output] of viewersOnly?[[true,true]]:[[false,false],[true,false],[false,true],[true,true]]){
    const state=await page.evaluate(kind=>globalThis[kind+'Node'].eagleAssetsEditor.state,kind);
    if(state.save_eagle!==eagle)await exporter.locator('[data-action=eagle]').click();
    if(state.save_output!==output)await exporter.locator('[data-action=output]').click();
    const before=await (await fetch(host+'/tests/stats')).json();
    const result=await run(kind,{tags:'story, character',annotation:'A full prompt, kept intact.\nSecond line.'});
    assert.equal(result.exports-before.exports,Number(eagle));
    assert.equal(result.output_files>before.output_files,output,'persistent output must match its independent switch');
    if(eagle){assert.equal(result.payload.folderId,'results');assert.deepEqual(result.payload.items[0].tags,['story','character']);assert.equal(result.payload.items[0].annotation,'A full prompt, kept intact.\nSecond line.');}
    await page.evaluate(({kind,ui})=>globalThis[kind+'Node'].onExecuted(ui),{kind,ui:result.ui});
    assert.equal(await exporter.locator('.ea-export-card').count(),1,'preview exists regardless of save switches');
   }
   if(!viewersOnly){
    const manual=await run(kind);assert.deepEqual(manual.payload.items[0].tags,['manual-tag']);assert.equal(manual.payload.items[0].annotation,'manual annotation');
    const cleared=await run(kind,{tags:'',annotation:''});assert.deepEqual(cleared.payload.items[0].tags,[]);assert.equal(cleared.payload.items[0].annotation,'');
    await page.evaluate(({kind,ui})=>globalThis[kind+'Node'].onExecuted(ui),{kind,ui:cleared.ui});
   }
   if(kind==='audio'||kind==='video'){
    const player=exporter.locator('.ea-export-media '+kind);assert.equal(await player.count(),1);await player.evaluate(element=>element.load());
    await page.waitForFunction(kind=>document.querySelector('#'+kind+' .ea-export-media '+kind)?.readyState>=1,kind);
   }else{
    const canvas=await visibleModel('OBJ');const before=await canvas.screenshot();
    await canvas.hover();await page.mouse.wheel(0,120);await page.waitForTimeout(150);const after=await canvas.screenshot();
    assert.notDeepEqual(before,after,'model viewer supports zoom interaction');
   }
  }
  for(const format of ['glb','gltf','stl']){
   const beforeResponses=responses.length;
   const result=await run('model',{model_format:format});
   await page.evaluate(ui=>modelNode.onExecuted(ui),result.ui);
   await visibleModel(format.toUpperCase());
   if(format==='gltf'){
    const resources=responses.slice(beforeResponses);
    assert.ok(resources.some(response=>response.status===200 && /\/gltf_buffer_\d+\.bin$/.test(response.url)),'glTF must fetch its actual external geometry buffer');
    assert.ok(resources.some(response=>response.status===200 && response.url.endsWith('/texture.png')),'glTF must fetch its actual external texture');
   }
  }
  const examples=path.join(__dirname,'..','examples');fs.mkdirSync(examples,{recursive:true});
  await page.locator('.layout').screenshot({path:path.join(examples,'exports-interface-preview.png')});
  assert.equal(errors.length,0,errors.join('\n'));
  console.log(viewersOnly?'MEDIA VIEWERS PASS: final Chinese status screenshot, real audio/video preview, visible OBJ/GLB/glTF/STL geometry, interactive zoom, external glTF buffer and texture loading.':'MEDIA EXPORT UI PASS: audio/video/model directories, four independent save switch combinations, persistent output counts, previews while disabled, tags/annotation input precedence and clearing, real audio/video files, offline interactive OBJ/GLB/glTF/STL viewers with external buffers/textures.');
  await page.evaluate(()=>Object.values(testNodes).forEach(node=>node.onRemoved?.()));
 }finally{if(browser)await browser.close();server.stdin.end('\n');if(server.exitCode===null)await new Promise(resolve=>server.once('exit',resolve));}
})().catch(error=>{console.error(error,diagnostics);process.exitCode=1});
