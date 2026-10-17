const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
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
  const page=await browser.newPage({viewport:{width:1800,height:1100}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  // Existing browser preferences migrate without losing the old single Skill.
  await page.addInitScript(()=>{if(!localStorage.getItem('migration-tested')){localStorage.setItem('ollama-studio.ui.v1',JSON.stringify({selected_skill:'shot-breakdown'}));localStorage.setItem('migration-tested','yes')}});
  await page.goto(host+'/tests/studio_ui_harness.html');await page.waitForFunction(()=>globalThis.studioHarnessReady);await page.evaluate(()=>OllamaStudioUI.ready);
  assert.deepEqual(await page.evaluate(()=>OllamaStudioUI.prefs.selected_skills),['shot-breakdown']);
  await page.getByRole('button',{name:'Skill 技能',exact:true}).click();
  await page.getByRole('button',{name:'添加 Skill 资产与连续性检查',exact:true}).click();
  assert.ok(await page.getByRole('dialog',{name:'Skill 技能',exact:true}).isVisible());
  assert.equal(await page.locator('.os-active-skill').count(),2);
  assert.equal(await page.getByRole('button',{name:'添加 Skill 资产与连续性检查',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'添加 Skill 视频参考帧分析',exact:true}).click();
  assert.equal(await page.locator('.os-active-skill').count(),3);
  const shots=path.join(__dirname,'feature-screenshots');fs.mkdirSync(shots,{recursive:true});
  await page.locator('.os-modal').screenshot({path:path.join(shots,'skills-add.png')});
  await page.locator('.os-modal-cover').click({position:{x:2,y:2}});assert.equal(await page.locator('.os-modal').count(),0);
  await page.getByRole('button',{name:'移除 Skill 视频参考帧分析',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>OllamaStudioUI.prefs.selected_skills),['shot-breakdown','asset-continuity']);
  assert.equal(await page.locator('[data-action=skills]').getAttribute('data-on'),'true');
  await page.evaluate(async()=>{OllamaStudioUI.prompt.value='Use both selected skills';await OllamaStudioUI.send()});
  const stats=await(await fetch(host+'/tests/studio-stats')).json();
  const system=stats.ollama_calls.at(-1).messages[0].content;
  assert.ok(system.indexOf('Break the supplied story segment')<system.indexOf("Review the user's script or shot list"));
  const id=await page.evaluate(()=>OllamaStudioUI.conversation.id);
  await page.evaluate(()=>OllamaStudioUI.setSkills([]));await page.evaluate(id=>OllamaStudioUI.loadConversation(id),id);
  assert.deepEqual(await page.evaluate(()=>OllamaStudioUI.prefs.selected_skills),['shot-breakdown','asset-continuity']);
  await page.locator('.os-panel').screenshot({path:path.join(shots,'skills-multiple.png')});
  await page.getByRole('button',{name:'移除 Skill 剧情片段 → 分镜清单',exact:true}).click();
  await page.getByRole('button',{name:'移除 Skill 资产与连续性检查',exact:true}).click();
  assert.equal(await page.locator('[data-action=skills]').getAttribute('data-on'),'false');
  assert.equal(await page.locator('.os-active-skill').count(),0);
  await page.getByRole('button',{name:'Skill 技能',exact:true}).click();
  await page.getByRole('button',{name:'添加 Skill 资产与连续性检查',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'添加 Skill 资产与连续性检查',exact:true}).isDisabled(),false,'removing a reference does not delete the skill');
  await page.locator('.os-modal-cover').click({position:{x:2,y:2}});
  const previewResult=await page.evaluate(async()=>{
   const {app}=await import('/scripts/app.js'),importer=importNode.eagleAssetsEditor;
   importer.state.folder_id='media_mix';importer.state.folder_ids=['media_mix'];importer.state.types=['image'];
   importer.invalidate();await importer.load();
   const descriptor=importer.items[0],target=document.createElement('section');target.style.width='550px';document.body.append(target);
   class ImageNode{
    constructor(){this.id=777;this.size=[550,660];this.inputs=[];this.graph=app.graph;this.imgs=['old-native-image'];this.widgets=[{name:'settings',value:JSON.stringify({version:1,host:studioFixture.mock_host})}]}
    addDOMWidget(name,type,element,options){target.append(element);return {name,type,element,options}}setSize(value){this.size=value}setDirtyCanvas(){}
    onExecuted(message){if(message.images)this.imgs=message.images;this.nativeSawImages=!!message.images}
   }
   await app.extensions.find(ext=>ext.name==='EagleAssets.ImportSortSplitExport').beforeRegisterNodeDef(ImageNode,{name:'EagleAssetExport'});
   const imageNode=new ImageNode();imageNode.onNodeCreated();
   const message={images:[descriptor.preview],eagle_media:[[{...descriptor.preview,name:'Fixture picture',media_type:'image',ext:'png'}]]};
   imageNode.onExecuted(message);
   return {native:imageNode.nativeSawImages,imgs:imageNode.imgs.length,custom:target.querySelectorAll('.ea-export-card').length};
  });
  assert.deepEqual(previewResult,{native:false,imgs:0,custom:1},'old cached output also renders exactly one custom preview');
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('MULTISKILL UI PASS: legacy preference migration, add multiple without closing, outside click closes, independent remove badges, real prompt composition, history restoration and non-destructive removal. Mock Ollama only.');
 }finally{if(browser)await browser.close();server.stdin.end('\n');if(server.exitCode===null)await new Promise(resolve=>server.once('exit',resolve));}
})().catch(error=>{console.error(error,diagnostics);process.exitCode=1});
