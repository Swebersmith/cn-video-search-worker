import assert from 'node:assert/strict';
import { test } from 'node:test';
import { piniaData } from '../src/ssr-data';

test('official SSR serializer is read as bounded literal data without executing scripts',()=>{
  const html='<script>window.__pinia=(function(a,b){return {searchResponse:{searchAllResponse:{page:a,result:[{result_type:"video",data:[{title:b}]}]}}}}(2,"<img src=x>"))</script>';
  const d=piniaData(html);
  assert.equal(d.searchResponse.searchAllResponse.page,2);
  assert.equal(d.searchResponse.searchAllResponse.result[0].data[0].title,'<img src=x>');
});
test('SSR parser rejects arbitrary calls, getters, assignments and executable arguments',()=>{
  for(const source of [
    '(function(){fetch("https://evil.test");return {}}())',
    '(function(){return fetch("https://evil.test")}())',
    '(function(){return {get x(){return 1}}}())',
    '(function(a){return {x:a}}(globalThis))',
    '(function(a){return {x:a}}(fetch("https://evil.test")))',
    '(function(){return {}}());alert(1)',
  ])assert.throws(()=>piniaData('<script>window.__pinia='+source+'</script>'),/OFFICIAL_SSR_SCHEMA_CHANGED/);
});
