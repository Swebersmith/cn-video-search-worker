import { parseExpressionAt } from 'acorn';
import { UpstreamError } from './providers';

// Read data expressions only. Never execute scripts received from upstream pages.
export function pageAssignment(html: string, name: string): any {
  const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1]).find(s => s.includes(name));
  if (!script) throw new UpstreamError('PLAYBACK_DATA_NOT_FOUND');
  const at = script.indexOf(name), equal = script.indexOf('=', at + name.length);
  if (equal < 0) throw new UpstreamError('PLAYBACK_SCHEMA_CHANGED');
  let visited = 0;
  function read(n: any, bindings: Record<string, unknown>, depth = 0): any {
    if (!n || depth > 100 || ++visited > 180000) throw Error('data limit');
    if (n.type === 'Literal' && !n.regex && typeof n.value !== 'bigint') return n.value;
    if (n.type === 'Identifier' && n.name === 'undefined') return undefined;
    if (n.type === 'Identifier' && Object.hasOwn(bindings, n.name)) return bindings[n.name];
    if (n.type === 'ArrayExpression') return n.elements.map((e: any) => e ? read(e, bindings, depth + 1) : null);
    if (n.type === 'ObjectExpression') {
      const out = Object.create(null);
      for (const p of n.properties) {
        if (p.type !== 'Property' || p.kind !== 'init' || p.computed || p.method) throw Error('not data');
        const k = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'Literal' ? String(p.key.value) : null;
        if (k === null) throw Error('key');
        out[k] = read(p.value, bindings, depth + 1);
      }
      return out;
    }
    if (n.type === 'UnaryExpression') {
      const v = read(n.argument, bindings, depth + 1);
      if (n.operator === '-' && typeof v === 'number') return -v;
      if (n.operator === '!') return !v;
      if (n.operator === 'void' && v === 0) return undefined;
    }
    if (n.type === 'CallExpression' && n.callee.type === 'FunctionExpression') {
      const fn = n.callee;
      if (fn.async || fn.generator || fn.body.body.at(-1)?.type !== 'ReturnStatement' || fn.params.length !== n.arguments.length) throw Error('serializer');
      const args = Object.create(null);
      fn.params.forEach((p: any, i: number) => {
        if (p.type !== 'Identifier' || Object.hasOwn(args, p.name)) throw Error('parameters');
        args[p.name] = read(n.arguments[i], bindings, depth + 1);
      });
      // Nuxt/devalue fills shared plain-object parameters before returning its data.
      // Only direct own-property writes to these local data objects are permitted.
      for (const statement of fn.body.body.slice(0, -1)) {
        const a = statement.expression, left = a?.left;
        if (statement.type !== 'ExpressionStatement' || a.type !== 'AssignmentExpression' || a.operator !== '=' || left.type !== 'MemberExpression' || left.object.type !== 'Identifier' || !Object.hasOwn(args, left.object.name)) throw Error('assignment');
        const target = args[left.object.name] as Record<string, unknown>;
        const key = left.computed ? read(left.property, args, depth + 1) : left.property.name;
        if (!target || typeof target !== 'object' || typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) throw Error('assignment target');
        target[key] = read(a.right, args, depth + 1);
      }
      return read(fn.body.body.at(-1).argument, args, depth + 1);
    }
    throw Error('unsupported script');
  }
  try { return read(parseExpressionAt(script, equal + 1, { ecmaVersion: 'latest' }), Object.create(null)); }
  catch { throw new UpstreamError('PLAYBACK_SCHEMA_CHANGED'); }
}

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
