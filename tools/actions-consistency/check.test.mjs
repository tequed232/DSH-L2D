/**
 * Phase 1 · 一致性巡检工具自测（含"去齿"验证）。
 *
 * 直跑：node --experimental-sqlite tools/actions-consistency/check.test.mjs
 * 为什么：巡检工具如果永远绿，就等于没有巡检。这里先造一致状态（应绿），
 * 再故意删图 / 造孤儿图，验证它会**真的报错/报警告**。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../packages/dsh-l2d-db/src/db.mjs';
import { publishBundleToDb } from '../../packages/dsh-l2d-db/src/action-manifest-repo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, 'check.mjs');

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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oaca-consist-'));
const dbFile = path.join(home, 'l2d-bridge.sqlite');
const MODEL = 'm-consist';
const ACTION = {
  actionId: 'head.nod',
  graphId: 'graph_head_nod',
  graphHash: 'gh-consist',
  capabilityRevision: 'rTEST',
  priority: 'NORMAL',
  triggers: ['interaction.head_nod'],
  parameters: {},
  requiresOwn: [],
  status: 'compiled',
};

// 造一致状态：DB + rev 目录 manifest + 图文件（带 oaca 标记）
const db = openDb({ path: dbFile });
publishBundleToDb(db, {
  modelId: MODEL,
  capabilityRevision: 'rTEST',
  compilerVersion: 'oaca-test',
  revision: 1,
  manifest: { manifestVersion: 1, modelId: MODEL, revision: 1, actions: [ACTION] },
  actions: [ACTION],
});
db.close();

const bundleDir = path.join(home, 'l2d-action-bundles', MODEL);
fs.mkdirSync(path.join(bundleDir, 'rev-1'), { recursive: true });
fs.writeFileSync(path.join(bundleDir, 'current.json'), JSON.stringify({ modelId: MODEL, revision: 1 }));
fs.writeFileSync(
  path.join(bundleDir, 'rev-1', 'manifest.json'),
  JSON.stringify({ manifestVersion: 1, modelId: MODEL, revision: 1, actions: [ACTION] }),
);
const graphDir = path.join(home, 'l2d-nodegraphs');
fs.mkdirSync(graphDir, { recursive: true });
const graphFile = path.join(graphDir, `${ACTION.graphId}.json`);
fs.writeFileSync(
  graphFile,
  JSON.stringify({ schemaVersion: 1, name: ACTION.graphId, meta: { oaca: { graphId: ACTION.graphId, contentHash: 'x' } } }),
);

function runCheck() {
  const r = spawnSync(process.execPath, ['--experimental-sqlite', CHECK, '--json', '--home', home, '--db', dbFile], {
    encoding: 'utf8',
  });
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = null;
  }
  return { code: r.status, report: parsed, stderr: r.stderr };
}

console.log('Phase 1 一致性巡检工具');

it('一致状态 → 退出码 0、无 error', () => {
  const { code, report } = runCheck();
  assert.equal(code, 0, `期望 0，实际 ${code}`);
  assert.equal(report.ok, true);
  assert.equal(report.models[0].dbPublished, 1);
  assert.deepEqual(report.models[0].missingGraph, []);
});

it('删掉图文件 → 退出码 1 且精确报 graph-file-missing（工具真有齿）', () => {
  const backup = fs.readFileSync(graphFile, 'utf8');
  fs.rmSync(graphFile);
  const { code, report } = runCheck();
  fs.writeFileSync(graphFile, backup);
  assert.equal(code, 1, '缺图必须让巡检失败，否则派发 404 无人发现');
  assert.ok(report.issues.some((i) => i.code === 'graph-file-missing' && i.actionId === 'head.nod'));
});

it('库里动作不在 manifest 中 → 报 db-action-not-in-manifest', () => {
  const manifestFile = path.join(bundleDir, 'rev-1', 'manifest.json');
  const backup = fs.readFileSync(manifestFile, 'utf8');
  fs.writeFileSync(manifestFile, JSON.stringify({ manifestVersion: 1, modelId: MODEL, revision: 1, actions: [] }));
  const { code, report } = runCheck();
  fs.writeFileSync(manifestFile, backup);
  assert.equal(code, 1);
  assert.ok(report.issues.some((i) => i.code === 'db-action-not-in-manifest'));
});

it('孤儿图只报 warning，不影响退出码', () => {
  const orphan = path.join(graphDir, 'graph_orphan.json');
  fs.writeFileSync(orphan, JSON.stringify({ schemaVersion: 1, name: 'graph_orphan', meta: { oaca: { graphId: 'graph_orphan' } } }));
  const { code, report } = runCheck();
  fs.rmSync(orphan);
  assert.equal(code, 0, '孤儿图是可清理项，不该阻断');
  assert.ok(report.issues.some((i) => i.code === 'orphan-graph' && i.level === 'warning'));
});

it('无人编译过（空库）→ 退出码 0，不误报', () => {
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oaca-consist-empty-'));
  const emptyDb = path.join(emptyHome, 'empty.sqlite');
  const d = openDb({ path: emptyDb });
  d.close();
  const r = spawnSync(process.execPath, ['--experimental-sqlite', CHECK, '--json', '--home', emptyHome, '--db', emptyDb], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  const rep = JSON.parse(r.stdout);
  assert.deepEqual(rep.models, []);
  fs.rmSync(emptyHome, { recursive: true, force: true });
});

fs.rmSync(home, { recursive: true, force: true });

console.log('');
if (process.exitCode) {
  console.error('actions-consistency: 存在失败');
  process.exit(1);
}
console.log(`actions-consistency: ${passed} 项全部通过`);
