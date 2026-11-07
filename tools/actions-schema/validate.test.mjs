/**
 * Actions JSON CLI 校验器回归测试（#32）。
 *
 * 复现 issue 原样：把 example fixture 改坏（confidence: 3 / created_at: "invalid" /
 * 第一步 duration_ms: -1000），修复前 CLI 仍打印 PASS 且退出码 0。
 * 运行：node tools/actions-schema/validate.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateMotion } from './validate.mjs';

const EXAMPLE = path.join(import.meta.dirname, 'examples', 'dafeiyu-tail-sway-happy.motion.json');
const base = () => JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}

console.log('actions-schema CLI 校验器（#32）');

ok('原版 example fixture → 无违规（修复不误伤）', () => {
  assert.deepEqual(validateMotion(base()), []);
});

ok('issue 原样三处改坏 → 3 条违规（confidence/date-time/duration_ms）', () => {
  const doc = base();
  doc.confidence = 3;
  doc.created_at = 'invalid';
  doc.actions_chain.steps[0].duration_ms = -1000;
  const errors = validateMotion(doc);
  assert.equal(errors.length, 3, `期望 3 条违规，实际 ${errors.length}: ${JSON.stringify(errors)}`);
  assert.ok(errors.some((e) => e.startsWith('confidence')));
  assert.ok(errors.some((e) => e.startsWith('created_at')));
  assert.ok(errors.some((e) => e.includes('duration_ms')));
});

ok('confidence 越界各形态（3 / -0.5 / "high"）→ 拒绝；0 / 1 / null → 放行', () => {
  for (const bad of [3, -0.5, 'high', Number.NaN]) {
    const doc = base();
    doc.confidence = bad;
    assert.ok(validateMotion(doc).some((e) => e.startsWith('confidence')), `confidence=${bad} 应拒绝`);
  }
  for (const good of [0, 1, null]) {
    const doc = base();
    doc.confidence = good;
    assert.ok(!validateMotion(doc).some((e) => e.startsWith('confidence')), `confidence=${good} 应放行`);
  }
});

ok('analysis_report.confidence 越界 → 拒绝', () => {
  const doc = base();
  doc.analysis_report.confidence = 3;
  assert.ok(validateMotion(doc).some((e) => e.startsWith('analysis_report.confidence')));
});

ok('created_at/updated_at 合法形态放行（Z / 带时区偏移 / 毫秒）', () => {
  const doc = base();
  doc.created_at = '2026-11-04T12:40:00+08:00';
  doc.updated_at = '2026-11-04T04:40:00.123Z';
  assert.deepEqual(validateMotion(doc), []);
});

ok('date-time 非法形态拒绝（裸字符串 / 缺 T / 缺时区 / 日历不存在）', () => {
  for (const bad of ['invalid', '2026-11-04 12:40:00', '2026-11-04T12:40:00', '2026-02-30T00:00:00Z']) {
    const doc = base();
    doc.created_at = bad;
    const errors = validateMotion(doc);
    assert.ok(errors.some((e) => e.startsWith('created_at')), `created_at=${bad} 应拒绝: ${JSON.stringify(errors)}`);
  }
});

ok('duration_ms 边界：0 与 30000 放行；-1000 / 30001 / 1.5 拒绝', () => {
  for (const good of [0, 30000]) {
    const doc = base();
    doc.actions_chain.steps[0].duration_ms = good;
    assert.ok(!validateMotion(doc).some((e) => e.includes('duration_ms')), `duration_ms=${good} 应放行`);
  }
  for (const bad of [-1000, 30001, 1.5, '400']) {
    const doc = base();
    doc.actions_chain.steps[0].duration_ms = bad;
    assert.ok(validateMotion(doc).some((e) => e.includes('duration_ms')), `duration_ms=${bad} 应拒绝`);
  }
});

if (process.exitCode) {
  console.error('actions-schema 校验器测试存在失败用例');
} else {
  console.log(`actions-schema validate ok（${passed} 用例）`);
}
