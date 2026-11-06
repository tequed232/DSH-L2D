/**
 * l2d_toolchain_status 数据源测试：真实临时库 → 读回快照；坏路径 → ok:false。
 * 运行：node --experimental-sqlite packages/dsh-l2d-mcp/src/toolchain-status.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../dsh-l2d-db/src/db.mjs';
import { upsertToolchainComponent } from '../../dsh-l2d-db/src/repo.mjs';
import { readToolchainStatus } from './toolchain-status.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-l2d-tc-'));
const dbFile = path.join(tmp, 'bootstrap-state.sqlite');

// 1. 空库 → ok:true，components 空
{
  const empty = readToolchainStatus({ dbPath: dbFile });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.components, []);
  assert.equal(empty.summary.total, 0);
}

// 2. 写入组件 → 读回一致（含 smoke JSON 反序列化）
{
  const db = openDb({ path: dbFile });
  upsertToolchainComponent(db, {
    name: 'py-moc3', kind: 'parser', version: 'v0.1.0@2fb112e',
    sourceUrl: 'https://github.com/Ludentes/py-moc3', status: 'present_verified',
    smokeTest: { files: [{ file: 'x.moc3', info: true, verify: true }], writeRoundTrip: 'full' },
  });
  upsertToolchainComponent(db, { name: 'LIVE2D-MOC3(rust)', kind: 'parser', status: 'missing' });
  db.close();

  const status = readToolchainStatus({ dbPath: dbFile });
  assert.equal(status.ok, true);
  assert.equal(status.components.length, 2);
  assert.equal(status.summary.presentVerified, 1);
  assert.equal(status.summary.missing, 1);
  const py = status.components.find((c) => c.name === 'py-moc3');
  assert.equal(py.version, 'v0.1.0@2fb112e');
  assert.equal(py.commitSha, null);
  assert.equal(py.smokeTest.writeRoundTrip, 'full');
}

// 3. 目录不可建（把文件路径当目录用）→ ok:false 如实报错
{
  const bad = path.join(tmp, 'not-a-dir');
  fs.writeFileSync(bad, 'x');
  const failed = readToolchainStatus({ dbPath: path.join(bad, 'sub', 'db.sqlite') });
  assert.equal(failed.ok, false);
  assert.ok(failed.reason);
}

console.log('toolchain-status: 3 tests passed');
try { db_closeTmp(); } catch { /* noop */ }
function db_closeTmp() { fs.rmSync(tmp, { recursive: true, force: true }); }
