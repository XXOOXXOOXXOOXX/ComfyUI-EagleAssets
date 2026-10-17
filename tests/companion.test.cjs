const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),assert=require('node:assert/strict');
(async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'eagle-bridge-test-'));let exit;
 const item={id:'fixture-item',name:'old',save:async()=>{item.saved=true}};
 try{
  const context={require,process:{platform:'win32',env:{LOCALAPPDATA:directory}},eagle:{library:{path:directory},item:{getById:async id=>id===item.id?item:null},onPluginCreate(callback){callback()}},document:{getElementById(){return{set textContent(value){}}}},window:{addEventListener(name,callback){exit=callback}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../eagle-companion/EagleAssetsBridge/bridge.js'),'utf8'),context);
  const file=path.join(directory,'EagleAssetsBridge/connection.json');for(let n=0;!fs.existsSync(file)&&n<50;n++)await new Promise(resolve=>setTimeout(resolve,20));
  const record=JSON.parse(fs.readFileSync(file,'utf8')),url=`http://127.0.0.1:${record.port}/rename`;
  let response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,403);
  const request=async body=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Eagle-Assets-Token':record.token},body:JSON.stringify(body)});
  response=await request({id:item.id,name:'new',library_path:path.join(directory,'wrong')});assert.equal(response.status,400);assert.equal(item.name,'old');
  response=await request({id:item.id,name:'新素材名',library_path:directory});assert.equal(response.status,200);assert.equal(item.name,'新素材名');assert.equal(item.saved,true);
  response=await request({id:item.id,name:'../bad',library_path:directory});assert.equal(response.status,400);
  console.log('Companion verified: loopback endpoint, required session token, matching library, SDK name/save, invalid-name rejection.');
 }finally{exit?.();const resolved=path.resolve(directory),tempRoot=path.resolve(os.tmpdir())+path.sep;if(!resolved.startsWith(tempRoot)||!path.basename(resolved).startsWith('eagle-bridge-test-'))throw new Error('Invalid cleanup directory');fs.rmSync(resolved,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1});
