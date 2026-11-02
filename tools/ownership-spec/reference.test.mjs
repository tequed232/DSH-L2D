/**
 * Ownership spec 自检：参考实现必须通过全部用例（进入 test:core）。
 * 实现方（渲染层）用 `node tools/ownership-spec/run.mjs <你的实现>` 跑同一批用例。
 */
import assert from 'node:assert/strict';
import { resolveWritePlan } from './reference.mjs';
import { cases } from './cases.mjs';

const sortWrites = (list) => [...list].sort((a, b) => a.id.localeCompare(b.id) || String(a.source).localeCompare(String(b.source)));
const sortRejected = (list) => [...list].sort((a, b) => (a.id + '|' + a.source + '|' + a.reason).localeCompare(b.id + '|' + b.source + '|' + b.reason));

for (const c of cases) {
  const variants = [{ name: 'normal', input: c.input }];
  if (c.shuffle) variants.push({ name: 'shuffled', input: { ...c.input, intents: [...c.input.intents].reverse() } });
  for (const v of variants) {
    const out = resolveWritePlan(v.input);
    assert.deepEqual(sortWrites(out.writes || []), sortWrites(c.expect.writes || []), c.id + '/' + v.name + ' writes');
    assert.deepEqual(sortRejected(out.rejected || []), sortRejected(c.expect.rejected || []), c.id + '/' + v.name + ' rejected');
  }
}

// 唯一 winner 的全局不变量：任何用例的 writes 里 id 不得重复。
for (const c of cases) {
  const out = resolveWritePlan(c.input);
  const ids = out.writes.map((w) => w.id);
  assert.equal(new Set(ids).size, ids.length, c.id + ' 出现重复 id（违反唯一 winner）');
}

console.log('ownership-spec: ok (' + cases.length + ' cases)');
