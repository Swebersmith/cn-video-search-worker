import { writeFile } from 'node:fs/promises';
import { createHandler } from '../src/index';
import { PLATFORMS, type Platform } from '../src/types';

const handler=createHandler(), base=process.env.API_BASE_URL||'https://local.test';
const probes: Record<Platform,string>={tencent:'三体',iqiyi:'三体',youku:'嫁金钗',mango:'歌手2025',bilibili:'三体'};
const report=await Promise.all((Object.keys(PLATFORMS) as Platform[]).map(async platform=>{
  const u=new URL(`/v1/${platform}/search`,base);
  u.searchParams.set('q',probes[platform]);u.searchParams.set('view','official');u.searchParams.set('page','1');
  try {
    const r=process.env.API_BASE_URL ? await fetch(u,{headers:process.env.API_KEY?{Authorization:`Bearer ${process.env.API_KEY}`}:{},signal:AbortSignal.timeout(45000)}) : await handler(new Request(u),{UPSTREAM_TIMEOUT_MS:'10000'});
    const d=await r.json() as any,p=d.providers?.[0];
    return {platform,status:r.status,count:d.total,view:d.view,source_url:p?.source_url,has_more:p?.has_more,upstream_present:!!p?.upstream,warnings:p?.warnings,first_title:d.results?.[0]?.title};
  }catch(e){return {platform,status:null,error:e instanceof Error?e.message:'SMOKE_FAILED'};}
}));
for(const row of report)console.log(JSON.stringify(row));
await writeFile('official-smoke-results.json',JSON.stringify({checked_at:new Date().toISOString(),base,report},null,2)+'\n');
if(report.some(r=>r.status!==200||!('upstream_present' in r)||!r.upstream_present))process.exitCode=1;
