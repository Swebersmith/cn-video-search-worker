import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mangoSearchUrl } from '../src/providers';

test('Mango checksum follows the public website serializer and actual request params', () => {
  const u = new URL(mangoSearchUrl('空 格&中文',2,new Date('2026-10-29T00:00:00Z'),'a-b-c'));
  assert.equal(u.pathname,'/pc/search/v2');
  assert.equal(u.searchParams.get('q'),'空 格&中文');
  const params = [...u.searchParams.entries()].filter(([k])=>k!=='signature').sort(([a],[b])=>a.localeCompare(b));
  const sorted = params.map(([k,v])=>encodeURI(k)+'='+encodeURI(v)).join('&');
  assert.equal(u.searchParams.get('signature'),createHash('md5').update('xHAa3YZflWLogZUOzl'+sorted+'xHAa3YZflWLogZUOzl').digest('hex'));
});
