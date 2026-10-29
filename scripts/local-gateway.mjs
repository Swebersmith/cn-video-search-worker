import {createServer} from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {allowedBilibiliUrl} from '../src/gateway-policy.ts';

export function createOfficialGateway(token,fetcher=fetch) {
  if(typeof token!=='string'||token.length<32)throw Error('A strong local gateway token is required');
  const digest=s=>createHash('sha256').update(s).digest();
  let active=0;
  return createServer(async(req,res)=>{
    const error=(status,code)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Official-Gateway-Error':code});res.end(JSON.stringify({error:code}));};
    if(!timingSafeEqual(digest(req.headers.authorization||''),digest('Bearer '+token)))return error(401,'UNAUTHORIZED');
    if(req.method==='GET'&&req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"ok":true,"service":"official-bilibili-local-origin"}');return;}
    if(req.method!=='POST'||req.url!=='/fetch')return error(404,'NOT_FOUND');
    if(active>=6)return error(503,'BUSY');
    active++;
    try {
      let input='',size=0;
      for await(const chunk of req){size+=chunk.length;if(size>16384)return error(413,'REQUEST_TOO_LARGE');input+=chunk.toString('utf8');}
      let data;try{data=JSON.parse(input);}catch{return error(400,'INVALID_JSON');}
      const target=allowedBilibiliUrl(data.url);
      if(!target)return error(400,'TARGET_NOT_ALLOWED');
      const headers={};
      for(const [k,v] of Object.entries(data.headers||{}))if(['user-agent','referer','accept','accept-language','cookie'].includes(k.toLowerCase())&&typeof v==='string'&&v.length<=4096&&!/[\r\n]/.test(v))headers[k]=v;
      const upstream=await fetcher(target.href,{headers,redirect:'manual',signal:AbortSignal.timeout(12000)});
      const reader=upstream.body?.getReader(),chunks=[];let length=0;
      if(reader)while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>3*1024*1024){await reader.cancel();return error(502,'RESPONSE_TOO_LARGE');}chunks.push(part.value);}
      res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('Content-Type')||'application/octet-stream','Cache-Control':'no-store','X-Official-Gateway':'local-origin'});
      res.end(Buffer.concat(chunks));
    }catch{return error(502,'UPSTREAM_UNAVAILABLE');}finally{active--;}
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const config=JSON.parse(await readFile(resolve('.local-gateway/config.json'),'utf8'));
  const server=createOfficialGateway(config.token);
  server.listen(config.port||8789,'127.0.0.1',()=>console.log('Official Bilibili local origin listening on loopback'));
}
