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
  const page=await browser.newPage({viewport:{width:2000,height:1600}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(host+'/tests/studio_ui_harness.html');await page.waitForFunction(()=>globalThis.studioHarnessReady&&!importNode.eagleAssetsEditor.busy);
  const types=['EagleAssetImport','EagleMediaImport','EagleStudioBridge','EagleAssetSort','EagleVideoSort','EagleAudioSort','EagleModelSort','EagleAssetExport','EagleVideoExport','EagleAudioExport','EagleModelExport'];
  await page.evaluate(async()=>{
   const original=importNode.eagleAssetsEditor;original.state.folder_id='media_mix';original.state.folder_ids=['media_mix'];original.state.types=['image','video','audio','model'];original.invalidate();await original.load();globalThis.resizeSource=structuredClone(original.items);
   const {app}=await import('/scripts/app.js');globalThis.resizeExtension=app.extensions.find(ext=>ext.name==='EagleAssets.ImportSortSplitExport');
   OllamaStudioUI.destroy();Object.values(testNodes).forEach(node=>node.onRemoved?.());document.querySelector('.layout').replaceChildren();
   globalThis.resizeMount=async(type,saved)=>{
    globalThis.resizedNode?.onRemoved?.();document.querySelector('.layout').replaceChildren();
    const target=document.createElement('section');target.id='resizing-node';target.className='mock-node';target.innerHTML='<div class="title"></div><div class="mount"></div>';target.querySelector('.title').textContent=type;document.querySelector('.layout').append(target);
    const defaults={version:1,host:studioFixture.mock_host,folder_id:'media_mix',folder_count:1,folder_ids:['media_mix'],types:['image','video','audio','model'],limit:20,selected_ids:[],filter_mode:true,preview_loaded:false,save_eagle:false,save_output:false};
    class Node{
     constructor(){this.id=900;this.type=type;this.size=[550,100];this.properties={};this.inputs=[];this.outputs=[];this.widgets=[{name:type.endsWith('Sort')?'sort_settings':'settings',value:JSON.stringify(defaults)}];this.graph=app.graph;this.resizeCount=0}
     addDOMWidget(name,type,element,options){const widget={name,type,element,options};this.widgets.push(widget);target.querySelector('.mount').append(element);return widget}
     addOutput(name,type){this.outputs.push({name,type})}
     computeSize(){const widget=this.widgets.find(widget=>widget.element);return [550,(widget?.options.getMinHeight?.()||0)+90]}
     setSize(size){this.resizeCount++;if(this.resizeCount>100)throw new Error('resize feedback loop');this.size=[size[0],Math.max(size[1],this.computeSize()[1])];target.style.width=this.size[0]+'px';const widget=this.widgets.find(widget=>widget.element);if(widget){const requested=widget.options.getHeight?.();target.querySelector('.mount').style.height=(requested==='100%'?this.size[1]-90:requested)+'px';widget.options.afterResize?.(this)}}
     setDirtyCanvas(){}
    }
    await resizeExtension.beforeRegisterNodeDef(Node,{name:type});const node=globalThis.resizedNode=new Node();node.onNodeCreated();node.onConfigure?.();if(saved)node.setSize(saved);
    const editor=node.eagleAssetsEditor,kind=type.includes('Video')?'video':type.includes('Audio')?'audio':type.includes('Model')?'model':'image';
    const source=resizeSource.find(item=>item.media_type===kind)||resizeSource[0];
    const items=Array.from({length:40},(_,i)=>({...source,id:'asset-'+i,name:`素材 ${i+1} · 布局测试`}));
    if(type.endsWith('Export')){editor.executed({eagle_media:[[{...source,preview_url:kind==='model'?source.model_url:source.preview_url,eagle_id:undefined}]],eagle_status:['布局预览测试']});await Promise.all(editor.modelViewers.map(viewer=>viewer.ready))}
    else if(type==='EagleStudioBridge'){editor.upstreamCatalog=()=>({catalog_id:'test',items});editor.sync()}
    else if(type.endsWith('Sort')){editor.upstreamItems=()=>items;editor.sync()}
    else{editor.items=items;editor.render()}
   };
   globalThis.resizeMetrics=()=>{const node=resizedNode,root=node.eagleAssetsEditor.root,preview=root.querySelector('.ea-grid,.ea-export-media'),fixed=root.querySelector('.ea-row');return {size:[...node.size],root:root.clientHeight,preview:preview.clientHeight,scroll:preview.scrollHeight,columns:getComputedStyle(preview).gridTemplateColumns.split(' ').length,fixed:fixed.clientHeight,minimum:node.widgets.find(widget=>widget.element).options.getMinHeight(),count:node.resizeCount,visual:root.querySelector('.ea-model-viewer,img,video')?.clientHeight||0}};
  });
  const settled=async()=>{await page.waitForTimeout(120);return page.evaluate(()=>resizeMetrics())};
  const report=[];
  for(const type of types){
   await page.evaluate(type=>resizeMount(type),type);let before=await settled();
   await page.evaluate(()=>resizedNode.setSize([resizedNode.size[0],resizedNode.size[1]+380]));const taller=await settled();
   assert.ok(Math.abs(taller.preview-before.preview-380)<3,type+' preview must fill vertical growth '+JSON.stringify({before,taller}));
   assert.equal(taller.fixed,before.fixed,type+' fixed controls do not stretch');
   if(type.endsWith('Export')&&!type.includes('Audio'))assert.ok(taller.visual>before.visual+300,type+' media itself grows with its viewport '+JSON.stringify({before,taller}));
   await page.evaluate(size=>resizedNode.setSize(size),before.size);const shorter=await settled();assert.ok(Math.abs(shorter.preview-before.preview)<3,type+' shrinking restores preview size');
   await page.evaluate(()=>resizedNode.setSize([1050,resizedNode.size[1]]));const wider=await settled();
   if(!type.endsWith('Export'))assert.ok(wider.columns>before.columns,type+' horizontal growth still adds columns');
   await page.evaluate(()=>resizedNode.setSize([resizedNode.size[0],resizedNode.size[1]+300]));const large=await settled();
   const stable=await settled();assert.equal(stable.count,large.count,type+' resize must settle without a loop');
   const saved=stable.size;await page.evaluate(({type,saved})=>resizeMount(type,saved),{type,saved});const restored=await settled();assert.deepEqual(restored.size,saved,type+' workflow restoration preserves resized node');
   const compact=[saved[0],restored.minimum+100];await page.evaluate(size=>resizedNode.setSize(size),compact);await settled();
   await page.evaluate(({type,compact})=>resizeMount(type,compact),{type,compact});const compactRestored=await settled();assert.deepEqual(compactRestored.size,compact,type+' compact size below the default survives restoration');
   if(type==='EagleMediaImport'){
    const old=compactRestored.size[1];await page.evaluate(()=>{const details=resizedNode.eagleAssetsEditor.root.querySelector('details');details.open=true});const expanded=await settled();assert.ok(expanded.size[1]>=old,'opening options never shrinks a manually enlarged node');assert.ok(expanded.preview>=125,'expanded controls leave a usable preview');
   }
   report.push({type,initialPreview:before.preview,tallPreview:taller.preview,columns:wider.columns});
  }
  await page.evaluate(()=>resizeMount('EagleMediaImport',[1050,1500]));await settled();
  const shots=path.join(__dirname,'feature-screenshots');fs.mkdirSync(shots,{recursive:true});await page.locator('#resizing-node').screenshot({path:path.join(shots,'resized-import.png')});
  await page.evaluate(()=>resizeMount('EagleAssetSort',[750,1000]));await settled();await page.locator('#resizing-node').screenshot({path:path.join(shots,'resized-sort.png')});
  await page.evaluate(()=>resizedNode.onRemoved?.());assert.equal(errors.length,0,errors.join('\n'));console.log('RESIZE UI PASS '+JSON.stringify(report));
 }finally{if(browser)await browser.close();server.stdin.end('\n');if(server.exitCode===null)await new Promise(resolve=>server.once('exit',resolve));}
})().catch(error=>{console.error(error,diagnostics);process.exitCode=1});
