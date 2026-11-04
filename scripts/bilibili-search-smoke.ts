import { writeFile } from 'node:fs/promises';
import { createHandler } from '../src/index';

const requests: {path:string;type:string|null;http:number}[]=[];
const handler=createHandler(async(url,init)=>{
  const response=await fetch(url,init), u=new URL(url);
  requests.push({path:u.pathname,type:u.searchParams.get('search_type'),http:response.status});
  return response;
});
const results=[];
for(const query of ['三体','甄嬛传']) {
  const response=await handler(new Request(`https://test/v1/bilibili/search?q=${encodeURIComponent(query)}&limit=20`),{UPSTREAM_TIMEOUT_MS:'10000'});
  const data=await response.json() as any;
  results.push({query,http:response.status,total:data.total,warnings:data.providers?.[0]?.warnings,results:data.results?.map((v:any)=>({id:v.id,title:v.title,type_name:v.type_name,url:v.url}))});
}
const report={checked_at:new Date().toISOString(),execution:'local_node_using_production_handler',requests,results};
console.log(JSON.stringify(report,null,2));
await writeFile('docs/bilibili-session-live-2026-11-04.json',JSON.stringify(report,null,2)+'\n');
if(results.some(v=>v.http!==200))process.exitCode=1;
