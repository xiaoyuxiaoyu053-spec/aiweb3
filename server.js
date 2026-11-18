'use strict';
/** DeepLine server: static app, AI proxy, protected admin API, aggregate analytics. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DEEPLINE_DATA_DIR || path.join(__dirname, 'data');
const MAX_BODY = 16 * 1024 * 1024;
const RATE_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN) || 90;
const ADMIN_PASSWORD = process.env.DEEPLINE_ADMIN_PASSWORD || '';
const PROVIDERS = {
  'DeepSeek': 'https://api.deepseek.com/chat/completions',
  'Claude': 'https://api.anthropic.com/v1/messages',
  '豆包': 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
  'ChatGPT / OpenAI': 'https://api.openai.com/v1/chat/completions',
};
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.wav':'audio/wav','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8' };
const COMPRESSIBLE = new Set(['.html','.js','.css','.json','.webmanifest','.svg','.txt']);
fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_FILE = path.join(DATA_DIR, 'admin-config.json');
const METRICS_FILE = path.join(DATA_DIR, 'metrics.json');
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) { const tmp=file+'.tmp'; fs.writeFileSync(tmp, JSON.stringify(value,null,2), {mode:0o600}); fs.renameSync(tmp,file); try { fs.chmodSync(file,0o600); } catch {} }
let config = readJson(CONFIG_FILE, { freeApi: { enabled: !!process.env.DEEPLINE_FREE_API_KEY, provider: process.env.DEEPLINE_FREE_API_PROVIDER || 'DeepSeek', model: process.env.DEEPLINE_FREE_API_MODEL || 'deepseek-chat', apiKey: process.env.DEEPLINE_FREE_API_KEY || '' }, announcement: { enabled:false, title:'', body:'', updatedAt:0 } });
config.freeApi ||= { enabled:false, provider:'DeepSeek', model:'deepseek-chat', apiKey:'' };
config.announcement ||= { enabled:false, title:'', body:'', updatedAt:0 };
let metrics = readJson(METRICS_FILE, { visits:0, apiRequests:0, freeApiRequests:0, userApiRequests:0, inputTokens:0, outputTokens:0, totalTokens:0, byDay:{} });
const sessions = new Map();
const hits = new Map();
function persistMetrics(){ try { writeJson(METRICS_FILE,metrics); } catch(e){ console.error('metrics save failed',e.message); } }
function dayKey(){ return new Date().toISOString().slice(0,10); }
function bump(key,n=1){ metrics[key]=(metrics[key]||0)+n; const d=dayKey(); metrics.byDay[d] ||= {visits:0,apiRequests:0,freeApiRequests:0,userApiRequests:0,inputTokens:0,outputTokens:0,totalTokens:0}; metrics.byDay[d][key]=(metrics.byDay[d][key]||0)+n; }
function securityHeaders(res){ res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',["default-src 'self'","script-src 'self'","style-src 'self' 'unsafe-inline'","img-src 'self' data: blob:","media-src 'self' data: blob:","font-src 'self' data:","connect-src 'self' https://api.deepseek.com https://api.anthropic.com https://ark.cn-beijing.volces.com https://api.openai.com","frame-ancestors 'none'","base-uri 'none'","form-action 'self'"].join('; '));res.setHeader('Permissions-Policy','microphone=(self), camera=()'); }
function sendJson(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));}
function readBody(req){return new Promise((resolve,reject)=>{let size=0,failed=false;const chunks=[];req.on('data',c=>{if(failed)return;size+=c.length;if(size>MAX_BODY){failed=true;chunks.length=0;reject(Object.assign(new Error('请求体过大'),{status:413}));return;}chunks.push(c);});req.on('end',()=>{if(!failed)resolve(Buffer.concat(chunks).toString('utf8'));});req.on('error',e=>{if(!failed)reject(e);});});}
function clientIp(req){return String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();}
function limited(ip,limit=RATE_PER_MIN){const now=Date.now(),a=(hits.get(ip)||[]).filter(t=>now-t<60000);a.push(now);hits.set(ip,a);return a.length>limit;}
function cookies(req){return Object.fromEntries(String(req.headers.cookie||'').split(';').map(x=>x.trim().split('=').map(decodeURIComponent)).filter(x=>x.length===2));}
function adminSession(req){const token=cookies(req).dl_admin;if(!token||!sessions.has(token))return false;const expires=sessions.get(token);if(Date.now()>expires){sessions.delete(token);return false;}return true;}
function requireAdmin(req,res){if(!adminSession(req)){sendJson(res,401,{error:'请先登录管理员账号'});return false;}return true;}
function publicConfig(){return {enabled:!!(config.freeApi.enabled&&config.freeApi.apiKey),provider:config.freeApi.provider,model:config.freeApi.model};}
function adminConfig(){return {freeApi:{enabled:!!config.freeApi.enabled,provider:config.freeApi.provider,model:config.freeApi.model,hasKey:!!config.freeApi.apiKey,keyHint:config.freeApi.apiKey?'已配置（不会显示密钥）':'未配置'},announcement:config.announcement};}
async function handleAi(req,res){
 if(limited(clientIp(req)))return sendJson(res,429,{error:{message:'请求太频繁，请稍后再试。'}});
 let p;try{p=JSON.parse(await readBody(req));}catch(e){return sendJson(res,e.status||400,{error:{message:e.status===413?'请求体过大':'请求格式错误'}});}
 const useFree=!!p.useFreeApi; let provider=p.provider, body=p.body, headers={};
 if(useFree){if(!config.freeApi.enabled||!config.freeApi.apiKey)return sendJson(res,503,{error:{message:'管理员尚未配置可用的免费 API'}});provider=config.freeApi.provider;body={...body,model:config.freeApi.model};headers=provider==='Claude'?{'x-api-key':config.freeApi.apiKey,'anthropic-version':'2023-06-01'}:{Authorization:'Bearer '+config.freeApi.apiKey};}
 else {for(const [k,v] of Object.entries(p.headers||{})){if(['authorization','x-api-key','anthropic-version'].includes(k.toLowerCase())&&typeof v==='string')headers[k.toLowerCase()]=v;}}
 const url=PROVIDERS[provider];if(!url)return sendJson(res,400,{error:{message:'不支持的 AI 服务商'}});if(!body||typeof body!=='object')return sendJson(res,400,{error:{message:'缺少请求内容'}});
 if(!useFree&&!headers.authorization&&!headers['x-api-key'])return sendJson(res,400,{error:{message:'缺少 API Key'}});
 const outHeaders={'Content-Type':'application/json',...headers};
 try{const upstream=await fetch(url,{method:'POST',headers:outHeaders,body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});const raw=await upstream.text();let json={};try{json=JSON.parse(raw);}catch{}
  bump('apiRequests');bump(useFree?'freeApiRequests':'userApiRequests');
  const usage=json.usage||{},input=Number(usage.input_tokens??usage.prompt_tokens??0)||0,output=Number(usage.output_tokens??usage.completion_tokens??0)||0,total=Number(usage.total_tokens??(input+output))||0;
  bump('inputTokens',input);bump('outputTokens',output);bump('totalTokens',total);persistMetrics();
  res.writeHead(upstream.status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(raw);
 }catch(e){bump('apiRequests');bump(useFree?'freeApiRequests':'userApiRequests');persistMetrics();sendJson(res,502,{error:{message:'服务器无法连接 AI 服务商：'+(e&&e.name==='TimeoutError'?'超时':(e&&e.message)||'未知错误')}});}
}
async function adminApi(req,res,pathname){
 if(pathname==='/api/admin/login'&&req.method==='POST'){if(!ADMIN_PASSWORD)return sendJson(res,503,{error:'服务器未设置 DEEPLINE_ADMIN_PASSWORD'});if(limited(clientIp(req),12))return sendJson(res,429,{error:'登录尝试过多，请稍后再试'});let b;try{b=JSON.parse(await readBody(req));}catch{return sendJson(res,400,{error:'请求格式错误'});}const a=Buffer.from(String(b.password||'')),z=Buffer.from(ADMIN_PASSWORD);if(a.length!==z.length||!crypto.timingSafeEqual(a,z))return sendJson(res,401,{error:'管理员密码错误'});const token=crypto.randomBytes(32).toString('hex');sessions.set(token,Date.now()+12*60*60*1000);res.setHeader('Set-Cookie',`dl_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.NODE_ENV==='production'?'; Secure':''}`);return sendJson(res,200,{ok:true});}
 if(pathname==='/api/admin/logout'&&req.method==='POST'){const t=cookies(req).dl_admin;sessions.delete(t);res.setHeader('Set-Cookie','dl_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return sendJson(res,200,{ok:true});}
 if(pathname==='/api/admin/me'&&req.method==='GET')return sendJson(res,200,{authenticated:!!adminSession(req),configured:!!ADMIN_PASSWORD});
 if(!requireAdmin(req,res))return;
 if(pathname==='/api/admin/metrics'&&req.method==='GET')return sendJson(res,200,metrics);
 if(pathname==='/api/admin/config'&&req.method==='GET')return sendJson(res,200,adminConfig());
 if(pathname==='/api/admin/config'&&req.method==='POST'){let b;try{b=JSON.parse(await readBody(req));}catch{return sendJson(res,400,{error:'请求格式错误'});}const f=b.freeApi||{};if(f.provider&&!PROVIDERS[f.provider])return sendJson(res,400,{error:'不支持的服务商'});config.freeApi.enabled=!!f.enabled;if(f.provider)config.freeApi.provider=f.provider;if(typeof f.model==='string'&&f.model.trim())config.freeApi.model=f.model.trim().slice(0,160);if(typeof f.apiKey==='string'&&f.apiKey.trim())config.freeApi.apiKey=f.apiKey.trim();if(f.clearKey===true)config.freeApi.apiKey='';writeJson(CONFIG_FILE,config);return sendJson(res,200,adminConfig());}
 if(pathname==='/api/admin/announcement'&&req.method==='POST'){let b;try{b=JSON.parse(await readBody(req));}catch{return sendJson(res,400,{error:'请求格式错误'});}config.announcement={enabled:!!b.enabled,title:String(b.title||'').slice(0,100),body:String(b.body||'').slice(0,2000),updatedAt:Date.now()};writeJson(CONFIG_FILE,config);return sendJson(res,200,{ok:true,announcement:config.announcement});}
 return sendJson(res,404,{error:'Not found'});
}
function serveStatic(req,res,pathname){let rel;try{rel=decodeURIComponent(pathname);}catch{return res.writeHead(400).end('Bad request');}if(rel.endsWith('/'))rel+='index.html';const file=path.normalize(path.join(PUBLIC_DIR,rel));if(!file.startsWith(PUBLIC_DIR+path.sep)&&file!==PUBLIC_DIR)return res.writeHead(403).end('Forbidden');fs.stat(file,(err,st)=>{if(err||!st.isFile()){if(!path.extname(rel))return serveStatic(req,res,'/index.html');res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Not found');}const ext=path.extname(file).toLowerCase(),headers={'Content-Type':MIME[ext]||'application/octet-stream','Cache-Control':ext==='.html'||ext==='.js'||ext==='.css'?'no-cache':'public, max-age=604800'};if(rel==='/index.html'&&req.method==='GET'){bump('visits');persistMetrics();}const gz=COMPRESSIBLE.has(ext)&&/\bgzip\b/.test(req.headers['accept-encoding']||'');if(gz){headers['Content-Encoding']='gzip';headers.Vary='Accept-Encoding';res.writeHead(200,headers);fs.createReadStream(file).pipe(zlib.createGzip()).pipe(res);}else{headers['Content-Length']=st.size;res.writeHead(200,headers);fs.createReadStream(file).pipe(res);}});}
const server=http.createServer(async(req,res)=>{securityHeaders(res);const {pathname}=new URL(req.url,'http://localhost');if(req.method==='GET'&&pathname==='/healthz')return sendJson(res,200,{ok:true});if(req.method==='GET'&&pathname==='/api/free-config')return sendJson(res,200,publicConfig());if(pathname.startsWith('/api/admin/'))return adminApi(req,res,pathname);if(req.method==='POST'&&pathname==='/api/ai')return handleAi(req,res);if(req.method==='GET'&&pathname==='/api/announcement')return sendJson(res,200,config.announcement.enabled?config.announcement:{enabled:false});if(req.method==='GET'||req.method==='HEAD')return serveStatic(req,res,pathname);res.writeHead(405);res.end('Method Not Allowed');});
server.listen(PORT,'0.0.0.0',()=>console.log(`DeepLine web listening on :${PORT}`));
