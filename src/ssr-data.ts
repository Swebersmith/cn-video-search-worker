import { parseExpressionAt } from 'acorn';
import { UpstreamError } from './providers';

// Interpret only the data-only function form used by the website's SSR serializer.
// No eval, Function, property access, arbitrary calls, assignments or page script execution.
export function piniaData(html: string): Record<string, any> {
  const scripts = html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi);
  for (const script of scripts) {
    const match = script[1].match(/^\s*window\.__pinia\s*=\s*([\s\S]*)$/);
    if (!match) continue;
    try {
      const source = match[1], root: any = parseExpressionAt(source,0,{ecmaVersion:'latest'});
      if (!/^\s*\)?\s*;?\s*$/.test(source.slice(root.end))) throw Error('trailing script');
      let visited=0;
      function value(node: any, bindings: Record<string,unknown>, depth=0): any {
        if (!node || depth>100 || ++visited>150000) throw Error('data limit');
        if(node.type==='Literal' && !node.regex && typeof node.value!=='bigint') return node.value;
        if(node.type==='Identifier' && Object.hasOwn(bindings,node.name))return bindings[node.name];
        if(node.type==='ArrayExpression')return node.elements.map((n:any)=>n?value(n,bindings,depth+1):null);
        if(node.type==='ObjectExpression') {
          const out=Object.create(null);
          for(const p of node.properties) {
            if(p.type!=='Property'||p.kind!=='init'||p.computed||p.method)throw Error('not data');
            const key=p.key.type==='Identifier'?p.key.name:p.key.type==='Literal'?String(p.key.value):null;
            if(key===null)throw Error('not data key');
            out[key]=value(p.value,bindings,depth+1);
          }
          return out;
        }
        if(node.type==='UnaryExpression') {
          const v=value(node.argument,bindings,depth+1);
          if(node.operator==='-' && typeof v==='number')return -v;
          if(node.operator==='!' && (typeof v==='number'||typeof v==='boolean'))return !v;
          if(node.operator==='void' && v===0)return undefined;
        }
        throw Error('unsupported expression');
      }
      if(root.type!=='CallExpression'||root.callee.type!=='FunctionExpression'||root.callee.async||root.callee.generator||root.callee.body.body.length!==1||root.callee.body.body[0].type!=='ReturnStatement')throw Error('not serializer');
      const bindings=Object.create(null), fn=root.callee;
      if(fn.params.length!==root.arguments.length)throw Error('arguments');
      fn.params.forEach((p:any,i:number)=>{
        if(p.type!=='Identifier'||Object.hasOwn(bindings,p.name))throw Error('parameters');
        bindings[p.name]=value(root.arguments[i],Object.create(null));
      });
      return value(fn.body.body[0].argument,bindings);
    }catch {throw new UpstreamError('OFFICIAL_SSR_SCHEMA_CHANGED');}
  }
  throw new UpstreamError('OFFICIAL_SSR_NOT_FOUND');
}
