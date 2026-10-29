export function allowedBilibiliUrl(raw: unknown): URL | null {
  if(typeof raw!=='string'||raw.length>4096)return null;
  try {
    const u=new URL(raw);
    if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash)return null;
    const paths: Record<string,RegExp>={
      'search.bilibili.com':/^\/all\/?$/,
      'www.bilibili.com':/^\/bangumi\/play\/ss\d+\/?$/,
      'api.bilibili.com':/^\/(?:x\/web-interface\/search\/(?:all\/v2|type)|x\/frontend\/finger\/spi|pgc\/view\/web\/season|pgc\/web\/season\/section)$/,
    };
    return paths[u.hostname]?.test(u.pathname)?u:null;
  }catch{return null;}
}
