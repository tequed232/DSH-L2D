#!/usr/bin/env node
/**
 * Ownership spec 执行器。
 *
 * 用法：
 *   node tools/ownership-spec/run.mjs                     # 跑参考实现（自检 spec）
 *   node tools/ownership-spec/run.mjs <implementation.mjs> # 跑你的 resolveWritePlan
 *
 * 实现要求：导出 `resolveWritePlan(input)`，返回 `{writes, rejected}`；
 * 语义与 docs/Ownership-Invariants.md 一致；实现路径可以是 TS（node --experimental-strip-types）。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cases } from './cases.mjs';

const entry = process.argv[2];
const target = entry ? path.resolve(entry) : new URL('./reference.mjs', import.meta.url);
const mod = await import(entry ? pathToFileURL(target).href : target.href);
const resolveWritePlan = mod.resolveWritePlan;
if (typeof resolveWritePlan !== 'function') {
  console.error('实现文件必须导出 resolveWritePlan(input)');
  process.exit(2);
}

const sortWrites = (list) => [...list].sort((a, b) => a.id.localeCompare(b.id) || String(a.source).localeCompare(String(b.source)));
const sortRejected = (list) => [...list].sort((a, b) => (a.id + '|' + a.source + '|' + a.reason).localeCompare(b.id + '|' + b.source + '|' + b.reason));

let failed = 0;
for (const c of cases) {
  const variants = [{ name: 'normal', input: c.input }];
  if (c.shuffle) variants.push({ name: 'shuffled', input: { ...c.input, intents: [...c.input.intents].reverse() } });
  for (const v of variants) {
    let out;
    try {
      out = resolveWritePlan(v.input);
    } catch (err) {
      failed++;
      console.log(`FAIL ${c.id}/${v.name}: 抛错 ${err && err.message ? err.message : err}`);
      continue;
    }
    try {
      assert.deepEqual(sortWrites(out.writes || []), sortWrites(c.expect.writes || []));
      assert.deepEqual(sortRejected(out.rejected || []), sortRejected(c.expect.rejected || []));
      console.log(`ok   ${c.id}/${v.name}: ${c.desc}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${c.id}/${v.name}: ${c.desc}`);
      console.log('  got     writes=' + JSON.stringify(sortWrites(out.writes || [])));
      console.log('  expected writes=' + JSON.stringify(sortWrites(c.expect.writes || [])));
      console.log('  got     rejected=' + JSON.stringify(sortRejected(out.rejected || [])));
      console.log('  expected rejected=' + JSON.stringify(sortRejected(c.expect.rejected || [])));
    }
  }
}
console.log(failed === 0 ? `ownership-spec: ok (${cases.length} cases)` : `ownership-spec: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
