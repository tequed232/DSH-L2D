/**
 * Phase 0 审计工具自测。
 *
 * 直跑：node tools/legacy-audit/audit.test.mjs
 * 为什么要有：审计工具若本身没验证，就会变成"另一个凭感觉的清单"。
 * 这里锁三类事实：① 目标都能解析 ② 判定取值合法且与角色一致 ③ 运行期可达性与手工核过的样本一致。
 */
import assert from 'node:assert/strict';
import { auditTargets, TARGETS } from './audit.mjs';

let passed = 0;
function it(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err && err.message}`);
    process.exitCode = 1;
  }
}

const VERDICTS = new Set(['delete-safe', 'retire-with-test', 'keep-import-time', 'keep-with-boundary', 'detach-first', 'review', 'missing']);
const report = auditTargets();
const byId = new Map(report.targets.map((t) => [t.id, t]));

console.log('Phase 0 依赖审计');

it('每个候选目标都能在盘上解析到文件（不允许"名字存在、文件不存在"）', () => {
  const missing = report.targets.filter((t) => t.verdict === 'missing').map((t) => t.id);
  assert.deepEqual(missing, [], `以下目标解析不到：${missing.join(', ')}`);
  for (const t of report.targets) assert.ok(t.fileCount > 0, `${t.id} 文件数为 0`);
});

it('判定取值都在枚举内，且每项都有理由', () => {
  for (const t of report.targets) {
    assert.ok(VERDICTS.has(t.verdict), `${t.id} 判定非法：${t.verdict}`);
    assert.ok(typeof t.reason === 'string' && t.reason.length > 0, `${t.id} 缺理由`);
  }
});

it('执行管道类（plumbing）不得被判为"待删"', () => {
  for (const t of report.targets.filter((x) => x.role === 'plumbing')) {
    assert.equal(t.verdict, 'keep-with-boundary', `${t.id} 属执行/编译通道，不应判为 ${t.verdict}`);
  }
});

it('core.planner 无运行期引用（与手工核查一致：仅自身子模块 + 一个测试）', () => {
  const planner = byId.get('core.planner');
  assert.equal(planner.runtimeReachable, false, 'planner 不应运行期可达');
  assert.equal(planner.runtimeRefs.length, 0);
  assert.ok(planner.testRefs.length >= 1, 'planner 至少被一个测试引用，所以是 retire-with-test 而非 delete-safe');
});

it('cue-loop 被 Renderer 引用 → 必须是 detach-first（不能直删）', () => {
  const cue = byId.get('core.cue-loop');
  assert.equal(cue.referencedByRenderer, true);
  assert.equal(cue.verdict, 'detach-first');
});

it('semantic-binding 有运行期引用（posture / core barrel），但不是导入期工具依赖', () => {
  const sb = byId.get('core.semantic-binding');
  assert.ok(sb.runtimeReachable, '应运行期可达');
  assert.deepEqual(sb.importTimeRefs, [], '不应有导入期工具依赖（此前误判来自注释提及）');
});

console.log('');
if (process.exitCode) {
  console.error('legacy-audit: 存在失败');
  process.exit(1);
}
console.log(`legacy-audit: ${passed} 项全部通过（目标 ${TARGETS.length} 项）`);
