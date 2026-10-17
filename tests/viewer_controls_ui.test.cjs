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
  const host=await ready;browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader'],...(process.env.VC_BROWSER_PATH?{executablePath:process.env.VC_BROWSER_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1800,height:1100}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/reversed-face.obj',route=>route.fulfill({contentType:'text/plain',body:'o reversed\nv -1 -1 0\nv 1 -1 0\nv 1 1 0\nv -1 1 0\nf 4 3 2 1\n'}));
  await page.goto(host+'/tests/studio_ui_harness.html');await page.waitForFunction(()=>globalThis.studioHarnessReady&&!importNode.eagleAssetsEditor.busy);
  await page.evaluate(async()=>{
   const editor=importNode.eagleAssetsEditor;editor.state.folder_id='media_mix';editor.state.folder_ids=['media_mix'];editor.state.types=['image','video','audio','model'];editor.invalidate();await editor.load();
   const {openMediaViewer}=await import('/eagle/web/media_viewer.js');globalThis.openFixtureViewer=kind=>openMediaViewer(editor.items.find(item=>item.media_type===kind),{apiURL:editor.mediaURL,url:item=>editor.mediaURL(item.media_url),modelURL:item=>editor.mediaURL(item.model_url)});
   await openFixtureViewer('video');
  });
  const viewer=page.locator('.eam-viewer'),mute=viewer.getByRole('button',{name:'静音或取消静音',exact:true}),slider=viewer.getByLabel('素材音量',{exact:true});
  await mute.hover();await slider.waitFor({state:'visible'});
  assert.ok(await slider.evaluate(element=>element.getBoundingClientRect().height>element.getBoundingClientRect().width*3));
  await slider.fill('35');await page.waitForFunction(()=>Math.abs(document.querySelector('.eam-viewer video').volume-.35)<.001);
  assert.equal(await viewer.locator('video').evaluate(media=>media.muted),false);
  await mute.click();await page.waitForFunction(()=>document.querySelector('.eam-viewer video').muted);
  await mute.click();await page.waitForFunction(()=>!document.querySelector('.eam-viewer video').muted);
  assert.equal(await viewer.locator('video').evaluate(media=>media.volume),.35);
  await slider.fill('0');await mute.click();await page.waitForFunction(()=>!document.querySelector('.eam-viewer video').muted&&document.querySelector('.eam-viewer video').volume>.3);
  const shots=path.join(__dirname,'feature-screenshots');fs.mkdirSync(shots,{recursive:true});await mute.hover();await viewer.screenshot({path:path.join(shots,'volume-slider.png')});
  await viewer.getByRole('button',{name:'关闭素材预览',exact:true}).click();await page.evaluate(()=>openFixtureViewer('audio'));
  assert.equal(await viewer.locator('audio').evaluate(media=>media.volume),.35,'volume persists between assets');
  await viewer.getByRole('button',{name:'关闭素材预览',exact:true}).click();
  await page.evaluate(async()=>{
   const ui=OllamaStudioUI,items=importNode.eagleAssetsEditor.items;ui.prefs.eagle_enabled=true;
   ui.eagleRefs=['media_image','media_video','media_audio','media_model'].map(id=>{const item=items.find(item=>item.id===id);return {...item,item_id:item.id,kind:item.media_type}});
   ui.renderAttachments();
  });
  await page.locator('.os-attachments .os-attachment').first().dblclick();const studio=page.locator('.os-asset-viewer');
  assert.equal(await studio.locator('.os-asset-counter').textContent(),'1 / 4');assert.equal(await studio.getByRole('button',{name:'上一个素材',exact:true}).isDisabled(),true);
  await studio.getByRole('button',{name:'下一个素材',exact:true}).click();await studio.locator('video').waitFor();
  await page.evaluate(async()=>{const media=document.querySelector('.os-asset-viewer video');globalThis.oldVideo=media;await media.play()});
  await studio.getByRole('button',{name:'下一个素材',exact:true}).click();await studio.locator('audio').waitFor();
  assert.equal(await page.evaluate(()=>oldVideo.paused&&oldVideo.getAttribute('src')===null),true);
  await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>document.querySelector('.os-asset-model canvas')?.dataset.modelReady==='true');
  assert.equal(await studio.locator('.os-asset-counter').textContent(),'4 / 4');assert.equal(await studio.getByRole('button',{name:'下一个素材',exact:true}).isDisabled(),true);
  await page.keyboard.press('ArrowLeft');await studio.locator('audio').waitFor();assert.equal(await studio.locator('canvas').count(),0,'switching disposes the model canvas');
  await studio.screenshot({path:path.join(shots,'gallery-navigation.png')});await page.keyboard.press('Escape');assert.equal(await studio.count(),0);
  await page.evaluate(()=>{
   const ui=OllamaStudioUI,attachments=[ui.eagleRefs[2],ui.eagleRefs[0]];
   ui.messages.replaceChildren(ui.messageElement({role:'user',content:'History attachment group',attachments}));
  });
  await page.locator('.os-inline-asset').last().dblclick();assert.equal(await studio.locator('.os-asset-counter').textContent(),'2 / 2');
  await studio.getByRole('button',{name:'上一个素材',exact:true}).click();await studio.locator('audio').waitFor();
  await studio.getByRole('button',{name:'关闭素材放大查看',exact:true}).click();
  await page.evaluate(()=>OllamaStudioUI.openAsset(OllamaStudioUI.eagleRefs[0],[OllamaStudioUI.eagleRefs[0]]));
  assert.equal(await studio.locator('.os-asset-nav:visible').count(),0,'single attachment hides navigation');
  await studio.getByRole('button',{name:'关闭素材放大查看',exact:true}).click();
  // A face whose winding points away from the default camera must still render.
  const pixels=await page.evaluate(async()=>{
   const {createModelPreview}=await import('/eagle/web/model_preview.js');const viewport=document.createElement('div');viewport.id='reverse-viewport';viewport.style.cssText='position:fixed;inset:30px auto auto 30px;width:500px;height:400px;z-index:5000';document.body.append(viewport);
   globalThis.reversePreview=createModelPreview(viewport,{url:location.origin+'/reversed-face.obj',ext:'obj',apiURL:url=>url});await reversePreview.ready;reversePreview.reset();
   const source=viewport.querySelector('canvas'),copy=document.createElement('canvas');copy.width=source.width;copy.height=source.height;const ctx=copy.getContext('2d');ctx.drawImage(source,0,0);const data=ctx.getImageData(0,0,copy.width,copy.height).data;
   let visible=0;for(let i=0;i<data.length;i+=4)if(Math.abs(data[i]-data[0])+Math.abs(data[i+1]-data[1])+Math.abs(data[i+2]-data[2])>40)visible++;
   return visible;
  });
  assert.ok(pixels>5000,'reversed-face geometry must remain visible, got '+pixels);await page.locator('#reverse-viewport').screenshot({path:path.join(shots,'reversed-face.png')});
  await page.evaluate(()=>{reversePreview.dispose();document.getElementById('reverse-viewport').remove();OllamaStudioUI.destroy()});assert.equal(errors.length,0,errors.join('\n'));
  console.log('VIEWER UI PASS: vertical volume, mute/unmute and zero-volume restore, persistent audio volume, gallery arrows/keyboard/boundaries/media cleanup, and real WebGL reversed-face visibility. Mock local files only.');
 }finally{if(browser)await browser.close();server.stdin.end('\n');if(server.exitCode===null)await new Promise(resolve=>server.once('exit',resolve));}
})().catch(error=>{console.error(error,diagnostics);process.exitCode=1});
