import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createOfficialGateway} from '../scripts/local-gateway.mjs';
import {allowedBilibiliUrl} from '../src/gateway-policy';
import {request} from '../src/providers';

test('local origin requires authentication and restricts its upstream to official Bilibili GET routes',async()=>{
  const token='a'.repeat(40),calls:{url:string;headers:any}[]=[];
  const server=createOfficialGateway(token,async(url,init)=>{calls.push({url,headers:init?.headers});assert.equal(init?.redirect,'manual');return new Response('official page',{headers:{'Content-Type':'text/html'}});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port,base=`http://127.0.0.1:${port}`;
  const send=(data:unknown,auth=true)=>fetch(base+'/fetch',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(data)});
  try{
    assert.equal((await send({url:'https://search.bilibili.com/all'},false)).status,401);
    for(const url of ['http://127.0.0.1/','https://api.bilibili.com.evil.test/','https://api.bilibili.com/passport','https://www.iqiyi.com/v_test.html','https://user:pass@api.bilibili.com/x/frontend/finger/spi'])assert.equal((await send({url})).status,400);
    assert.equal(calls.length,0);
    const r=await send({url:'https://search.bilibili.com/all?keyword=三体',headers:{'User-Agent':'browser',Authorization:'do not forward',Cookie:'buvid3=official'}});
    assert.equal(r.status,200);assert.equal(await r.text(),'official page');
    assert.equal(calls[0].headers.Authorization,undefined);
    assert.equal(calls[0].headers.Cookie,'buvid3=official');
    assert.equal(r.headers.get('X-Official-Gateway'),'local-origin');
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('Worker sends Bilibili requests through its authenticated local origin, without changing other sites',async()=>{
  const calls:string[]=[];
  const env={BILIBILI_GATEWAY_URL:'https://bili-origin.example.test',BILIBILI_GATEWAY_TOKEN:'private-token'};
  const f=async(url:string,init?:RequestInit)=>{
    calls.push(url);
    if(url.includes('bili-origin')){
      assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer private-token');
      const d=JSON.parse(String(init?.body));
      assert.equal(d.url,'https://search.bilibili.com/all?keyword=test');
      assert.ok(!String(init?.body).includes('private-token'));
    }
    return new Response('official response');
  };
  assert.equal(await request('https://search.bilibili.com/all?keyword=test',env,f),'official response');
  await request('https://www.iqiyi.com/v_test.html',env,f);
  assert.deepEqual(calls,['https://bili-origin.example.test/fetch','https://www.iqiyi.com/v_test.html']);
  for(const raw of ['https://api.bilibili.com/x/frontend/finger/spi','https://www.bilibili.com/bangumi/play/ss45975'])assert.ok(allowedBilibiliUrl(raw));
});
