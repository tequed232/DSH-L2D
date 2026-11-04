/**
 * P0-B Task Contract 测试：状态机 / Schema 校验 / 并发领取 / 重试上限 / 溯源关联
 * 运行：node packages/dsh-l2d-db/test/task-contract.test.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.mjs';
import {
  createTaskContract, contractStatusOfDbStatus, validateAgainstSchema, OPERATION_SCHEMAS,
} from '../src/task-contract.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-task-contract-'));
const db = openDb({ path: path.join(tmp, 'test.sqlite') });
const tasks = createTaskContract(db);

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}

const VALID_INPUT = { assetPaths: ['/a.png'], sourceId: 'src-1', modelCapabilityId: 'cap-1' };

console.log('P0-B Task Contract');

ok('happy path：create → claim → complete，attempt 递增、trace 关联', () => {
  const t = tasks.create({ taskType: 'learning.ingest_gallery', workspaceId: 'learning', input: VALID_INPUT, traceId: 'trace-1' });
  assert.equal(t.status, 'pending');
  const claimed = tasks.claim(t.taskId, 'learning-agent');
  assert.equal(claimed.status, 'processing');
  assert.equal(claimed.attempt, 1);
  const done = tasks.complete(t.taskId, { jobId: 'job-1', state: 'persisted' });
  assert.equal(done.status, 'completed');
  assert.equal(tasks.listByTrace('trace-1').length, 1);
  assert.equal(tasks.listByWorkspace('learning', 'completed').length, 1);
});

ok('未知 taskType / 未知 workspace / 非法 input 均 fail-closed', () => {
  assert.throws(() => tasks.create({ taskType: 'made.up.op', workspaceId: 'chat', input: {} }), (e) => e.code === 'UNKNOWN_TASK_TYPE');
  assert.throws(() => tasks.create({ taskType: 'learning.status', workspaceId: 'alien', input: { jobId: 'x' } }), (e) => e.code === 'UNKNOWN_WORKSPACE');
  assert.throws(() => tasks.create({ taskType: 'learning.status', workspaceId: 'chat', input: { jobId: 42 } }), (e) => e.code === 'INPUT_SCHEMA_INVALID');
  assert.throws(() => tasks.create({ taskType: 'learning.status', workspaceId: 'chat', input: '自由文本' }), (e) => e.code === 'INPUT_SCHEMA_INVALID');
});

ok('重复领取 → CLAIM_CONFLICT；running 领取亦冲突', () => {
  const t = tasks.create({ taskType: 'runtime.cancel', workspaceId: 'runtime', input: { executionId: 'e1' } });
  tasks.claim(t.taskId, 'a');
  assert.throws(() => tasks.claim(t.taskId, 'b'), (e) => e.code === 'CLAIM_CONFLICT');
});

ok('非法转换：pending 直接 complete / cancelled 再取消均拒绝', () => {
  const t = tasks.create({ taskType: 'runtime.cancel', workspaceId: 'chat', input: { executionId: 'e2' } });
  assert.throws(() => tasks.complete(t.taskId, { cancelled: true }), (e) => e.code === 'ILLEGAL_TRANSITION');
  const t2 = tasks.create({ taskType: 'runtime.cancel', workspaceId: 'chat', input: { executionId: 'e3' } });
  tasks.cancel(t2.taskId, '用户取消');
  assert.throws(() => tasks.cancel(t2.taskId), (e) => e.code === 'ILLEGAL_TRANSITION');
});

ok('retryable 失败且未超限 → 回到 pending（重试）', () => {
  const t = tasks.create({ taskType: 'runtime.search_and_execute', workspaceId: 'runtime', input: { intent: { action: 'wave' }, modelId: 'm', requireValidated: true }, maxAttempts: 3 });
  tasks.claim(t.taskId, 'w');
  const after = tasks.fail(t.taskId, { code: 'E_TMP', message: '临时故障', retryable: true });
  assert.equal(after.status, 'pending');
  assert.equal(after.attempt, 1);
  // 第二次失败后仍可重试（attempt=2 < 3）
  tasks.claim(t.taskId, 'w');
  const after2 = tasks.fail(t.taskId, { code: 'E_TMP', message: '仍失败', retryable: true });
  assert.equal(after2.status, 'pending');
  // 第三次失败：attempt=3 = maxAttempts → 终态 failed
  tasks.claim(t.taskId, 'w');
  const after3 = tasks.fail(t.taskId, { code: 'E_FINAL', message: '耗尽', retryable: true });
  assert.equal(after3.status, 'failed');
  assert.equal(after3.error.code, 'E_FINAL');
});

ok('非 retryable 失败 → 直接终态 failed', () => {
  const t = tasks.create({ taskType: 'runtime.search_and_execute', workspaceId: 'runtime', input: { intent: {}, modelId: 'm', requireValidated: false } });
  tasks.claim(t.taskId, 'w');
  const after = tasks.fail(t.taskId, { code: 'E_BAD', message: '不可重试', retryable: false });
  assert.equal(after.status, 'failed');
});

ok('error 结构不完整 → 拒绝（稳定错误契约）', () => {
  const t = tasks.create({ taskType: 'runtime.cancel', workspaceId: 'chat', input: { executionId: 'e4' } });
  tasks.claim(t.taskId, 'w');
  assert.throws(() => tasks.fail(t.taskId, { code: 'X', message: '缺 retryable' }));
});

ok('output Schema 校验：不匹配的 output 拒绝完成', () => {
  const t = tasks.create({ taskType: 'learning.status', workspaceId: 'learning', input: { jobId: 'j9' } });
  tasks.claim(t.taskId, 'w');
  assert.throws(() => tasks.complete(t.taskId, { jobId: 1, state: 'x' }), (e) => e.code === 'OUTPUT_SCHEMA_INVALID');
});

ok('状态映射显式：未知 DB 状态拒绝；契约/DB 双向一致', () => {
  assert.throws(() => contractStatusOfDbStatus('alien_state'));
  assert.equal(contractStatusOfDbStatus('assigned'), 'processing');
  assert.equal(contractStatusOfDbStatus('done'), 'completed');
  for (const [contract, dbStatus] of Object.entries({ pending: 'pending', processing: 'running', completed: 'done', failed: 'failed', cancelled: 'cancelled' })) {
    assert.equal(contractStatusOfDbStatus(dbStatus), contract);
  }
});

ok('Schema 注册表版本化且可执行', () => {
  for (const [op, schema] of Object.entries(OPERATION_SCHEMAS)) {
    assert.match(schema.schemaVersion, /^1\.\d+$/, `${op} schema 应有版本`);
  }
  assert.equal(validateAgainstSchema({ assetPaths: ['a'], sourceId: 's', modelCapabilityId: 'c' }, OPERATION_SCHEMAS['learning.ingest_gallery'].input).length, 0);
  assert.ok(validateAgainstSchema({ assetPaths: [1] }, OPERATION_SCHEMAS['learning.ingest_gallery'].input).length > 0);
});

ok('三类工作区任务均可创建（chat/learning/runtime）', () => {
  for (const ws of ['chat', 'learning', 'runtime']) {
    const t = tasks.create({ taskType: 'runtime.cancel', workspaceId: ws, input: { executionId: 'x' } });
    assert.equal(t.workspaceId, ws);
  }
});

console.log(`\n结果：${process.exitCode ? '存在失败' : '全部通过'}（${passed} 项断言组）`);
if (process.exitCode) process.exit(1);
