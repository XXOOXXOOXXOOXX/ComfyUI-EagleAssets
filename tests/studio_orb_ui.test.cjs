const {chromium}=require('playwright');
const {spawn,spawnSync}=require('node:child_process');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const server=spawn(process.env.VC_PYTHON||'python',[path.join(__dirname,'studio_fixture.py')],{stdio:['pipe','pipe','pipe'],windowsHide:true});
let diagnostics='';server.stderr.on('data',chunk=>diagnostics+=chunk.toString());
const ready=new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('Orb fixture timeout '+diagnostics)),45000);server.stdout.on('data',chunk=>{output+=chunk;try{const data=JSON.parse(output.split('\n')[0]);clearTimeout(timer);resolve(data.host)}catch{}});server.on('exit',code=>{clearTimeout(timer);reject(new Error('Fixture exited '+code+' '+diagnostics))})});
const pixelCheck=buffer=>{
 const source="import sys,io,json\nfrom PIL import Image\nimport numpy as np\np=np.asarray(Image.open(io.BytesIO(sys.stdin.buffer.read())).convert('RGB'),dtype=np.int16)\nm=(p.max(axis=2)>95)&((p.max(axis=2)-p.min(axis=2))>15)\nprint(json.dumps({'colored':int(m.sum()),'corner':bool(m[0,0]),'center':bool(m[p.shape[0]//2,p.shape[1]//2])}))";
 const result=spawnSync(process.env.VC_PYTHON||'python',['-c',source],{input:buffer,windowsHide:true});assert.equal(result.status,0,result.stderr.toString());return JSON.parse(result.stdout.toString());
};
(async()=>{
 let browser;
 try{
  const host=await ready;browser=await chromium.launch({headless:true,...(process.env.VC_BROWSER_PATH?{executablePath:process.env.VC_BROWSER_PATH}:{})});
  const stylesheet=fs.readFileSync(path.join(__dirname,'../../ComfyUI-OllamaStudio/web/studio.css'),'utf8');
  const fixMarker=stylesheet.indexOf('/* The minimized orb uses an empty span:');assert.ok(fixMarker>=0,'the reproduction removes only the appended orb fix');
  const oldPage=await browser.newPage({viewport:{width:1280,height:920}});
  await oldPage.route('**/studio/web/studio.css*',route=>route.fulfill({status:200,contentType:'text/css',body:stylesheet.slice(0,fixMarker)}));
  await oldPage.goto(host+'/tests/studio_ui_harness.html');await oldPage.waitForFunction(()=>globalThis.studioHarnessReady&&globalThis.OllamaStudioUI?.conversation?.id);
  await oldPage.locator('.os-panel [data-action=minimize]').click();
  const collapsed=await oldPage.locator('.os-orb .os-orb-art').boundingBox();assert.ok(collapsed.width<16,'the unfixed inline empty span reproduces the thin orb');
  console.log('ORB REPRODUCED WITHOUT FIX: art '+collapsed.width+' × '+collapsed.height+' px');
  await oldPage.evaluate(()=>OllamaStudioUI.destroy());await oldPage.close();
  const page=await browser.newPage({viewport:{width:1280,height:920}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(host+'/tests/studio_ui_harness.html');await page.waitForFunction(()=>globalThis.studioHarnessReady&&globalThis.OllamaStudioUI?.conversation?.id);
  const shots=path.join(__dirname,'studio-screenshots');fs.mkdirSync(shots,{recursive:true});
  for(const hostCss of [false,true]){
   if(hostCss)await page.addStyleTag({content:'button{display:inline-flex;box-sizing:border-box;min-width:0;min-height:0;padding:6px 14px;font:14px/1.25 system-ui}button span{display:inline;white-space:nowrap}span{vertical-align:baseline}'});
   const welcome=await page.locator('.os-welcome .os-orb-art').boundingBox();assert.ok(welcome.width>=60&&welcome.height>=60,'welcome art keeps its actual circular box');
   await page.locator('.os-panel [data-action=minimize]').click();const orb=page.locator('.os-orb'),art=orb.locator('.os-orb-art');
   const buttonBox=await orb.boundingBox(),artBox=await art.boundingBox();
   for(const value of [buttonBox.width,buttonBox.height])assert.ok(Math.abs(value-64)<0.6,'minimized button renders as 64 × 64');
   for(const value of [artBox.width,artBox.height])assert.ok(Math.abs(value-54)<0.6,'empty-span art renders as 54 × 54');
   assert.ok(Math.abs(buttonBox.x+buttonBox.width/2-640)<0.6,'orb stays at bottom center');assert.ok(Math.abs(920-(buttonBox.y+buttonBox.height)-20)<0.6,'orb keeps its bottom spacing');
   const style=await art.evaluate(element=>{const value=getComputedStyle(element);return{display:value.display,radius:value.borderRadius,image:value.backgroundImage}});
   assert.equal(style.display,'block');assert.equal(style.radius,'50%');assert.match(style.image,/radial-gradient/);assert.match(style.image,/conic-gradient/);
   const pixels=pixelCheck(await orb.screenshot());assert.ok(pixels.colored>1000,'a visibly colored sphere is rendered');assert.equal(pixels.corner,false,'the orb does not fill square corners');assert.equal(pixels.center,true,'the center contains colored art');
   await orb.screenshot({path:path.join(shots,hostCss?'orb-host-css.png':'orb.png')});
   if(hostCss)await page.screenshot({path:path.join(shots,'orb-context.png'),clip:{x:430,y:760,width:420,height:160}});
   await orb.click();assert.ok(await page.locator('.os-panel').isVisible());assert.ok(await orb.isHidden());
  }
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('ORB UI PASS: unfixed span width collapse reproduced; real 64px button/54px circular colored art, bottom-center position and click restore pass with normal and generic host button/span CSS.');
  await page.evaluate(()=>OllamaStudioUI.destroy());
 }finally{if(browser)await browser.close();server.stdin.end('\n');if(server.exitCode===null)await new Promise(resolve=>server.once('exit',resolve));}
})().catch(error=>{console.error(error,diagnostics);process.exitCode=1});
