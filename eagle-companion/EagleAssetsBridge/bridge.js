const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const base = process.platform === 'win32' ? (process.env.LOCALAPPDATA || path.join(os.homedir(),'AppData','Local')) : process.platform === 'darwin' ? path.join(os.homedir(),'Library','Application Support') : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(),'.config'));
const directory = path.join(base,'EagleAssetsBridge'), connection = path.join(directory,'connection.json');
const token = crypto.randomBytes(32).toString('hex');
const normalize = value => { const resolved = path.resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
let server;
eagle.onPluginCreate(() => {
    server = http.createServer(async (request, response) => {
        const reply = (status, value) => { response.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store'}); response.end(JSON.stringify(value)); };
        if (request.method !== 'POST' || request.url !== '/rename' || request.headers['x-eagle-assets-token'] !== token) { reply(403,{ok:false}); return; }
        let raw = '', tooLarge = false;
        request.setEncoding('utf8'); request.on('data', part => { raw += part; if (raw.length > 4096) { tooLarge = true; request.destroy(); } });
        request.on('end', async () => {
            if (tooLarge) return;
            try {
                const data = JSON.parse(raw);
                if (!data || typeof data.id !== 'string' || !/^[\w-]+$/.test(data.id) || typeof data.name !== 'string' || !data.name.trim() || data.name.length > 240 || /[<>:"/\\|?*\x00-\x1f]/.test(data.name)) throw new Error('Invalid item');
                if (typeof data.library_path !== 'string' || normalize(eagle.library.path) !== normalize(data.library_path)) throw new Error('Library changed');
                const item = await eagle.item.getById(data.id);
                if (!item || item.isDeleted) throw new Error('Item missing');
                item.name = data.name.trim(); await item.save();
                reply(200,{ok:true,name:item.name,id:item.id});
            } catch { reply(400,{ok:false,error:'Eagle 素材改名未成功，请确认素材库和素材状态。'}); }
        });
    });
    server.on('error', () => { document.getElementById('status').textContent = '服务未启动，请重新加载此 Eagle 插件。'; });
    server.listen(0,'127.0.0.1',() => {
        fs.mkdirSync(directory,{recursive:true,mode:0o700});
        fs.writeFileSync(connection,JSON.stringify({port:server.address().port,token}),{mode:0o600});
        document.getElementById('status').textContent = '服务已运行，ComfyUI 会自动连接。连接记录：'+connection;
    });
});
window.addEventListener('beforeunload', () => {
    server?.close();
    try { if (JSON.parse(fs.readFileSync(connection,'utf8')).token === token) fs.unlinkSync(connection); } catch {}
});
