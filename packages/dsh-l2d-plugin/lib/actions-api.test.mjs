/**
 * /dsh-l2d/api/actions（宿主）与 dev-server /api/actions 共用 actions-api.mjs：
 * 同一库、同一过滤口径；overlay 用插件前缀请求，dev-server 剥前缀后落到同一路由。
 *   node packages/dsh-l2d-plugin/lib/actions-api.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { actionsSource, handleActionsRequest, queryValidatedActions, DEFAULT_ACTIONS_DB_FILE, DEFAULT_ACTIONS_MODEL_ID, REPO_ROOT } from './actions-api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-api-'));
const dbFile = path.join(tmp, 'bootstrap-state.sqlite');
const db = new DatabaseSync(dbFile);
db.exec(`
  CREATE TABLE motion_definitions (id TEXT PRIMARY KEY, semantic_key TEXT, emotion TEXT, status TEXT);
  CREATE TABLE action_chains (id TEXT PRIMARY KEY, motion_id TEXT, chain_json TEXT);
  CREATE TABLE motion_model_bindings (motion_id TEXT, model_id TEXT, compatible INTEGER, adapter_json TEXT);
`);
const add = (id, key, status, model, compatible) => {
  db.prepare('INSERT INTO motion_definitions VALUES (?,?,?,?)').run(id, key, 'happy', status);
  db.prepare('INSERT INTO action_chains VALUES (?,?,?)').run('c-' + id, id, '[{"motion":"x"}]');
  db.prepare('INSERT INTO motion_model_bindings VALUES (?,?,?,?)').run(id, model, compatible, '{}');
};
add('m1', 'wave', 'validated', '大肥鱼.dsl2d', 1);
add('m2', 'nod', 'validated', '大肥鱼.dsl2d', 1);
add('m3', 'tail-sway-happy', 'draft', '大肥鱼.dsl2d', 1);
add('m4', 'spin', 'validated', '大肥鱼.dsl2d', 0);
add('m5', 'jump', 'validated', '别的模型', 1);
db.close();

// 过滤口径：validated + compatible=1 + 当前模型，按 semantic_key 排序
const rows = await queryValidatedActions({ dbFile, modelId: '大肥鱼.dsl2d' });
assert.deepEqual(rows.map((r) => r.semanticKey), ['nod', 'wave']);
assert.deepEqual(Object.keys(rows[0]).sort(), ['adapterJson', 'chainId', 'chainJson', 'emotion', 'motionId', 'semanticKey']);
assert.equal(rows[0].chainId, 'c-m2');
// 库缺失 → 空集，不抛
assert.deepEqual(await queryValidatedActions({ dbFile: path.join(tmp, 'nope.sqlite'), modelId: 'x' }), []);
// 路由处理：GET → {ok:true, actions}；其它方法 405
const ok = await handleActionsRequest('GET', { dbFile, modelId: '大肥鱼.dsl2d' });
assert.equal(ok.status, 200);
assert.equal(ok.payload.ok, true);
assert.equal(ok.payload.actions.length, 2);
assert.equal((await handleActionsRequest('POST', { dbFile, modelId: 'x' })).status, 405);
// 数据来源与 dev-server 一致：<仓库根>/data/bootstrap-state.sqlite，环境变量可覆盖
assert.equal(DEFAULT_ACTIONS_DB_FILE, path.join(REPO_ROOT, 'data', 'bootstrap-state.sqlite'));
assert.ok(fs.existsSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml')), 'REPO_ROOT 指向仓库根');
assert.deepEqual(actionsSource({}), { dbFile: DEFAULT_ACTIONS_DB_FILE, modelId: DEFAULT_ACTIONS_MODEL_ID });
assert.deepEqual(actionsSource({ DSH_L2D_ACTIONS_DB: dbFile, DSH_L2D_ACTIONS_MODEL_ID: 'm' }), { dbFile, modelId: 'm' });

// 接线：宿主有 /dsh-l2d/api/actions；overlay 用插件前缀；dev-server 共用实现且剥 /dsh-l2d 前缀
const indexSrc = fs.readFileSync(path.join(here, 'index.js'), 'utf8');
const overlaySrc = fs.readFileSync(path.join(here, 'overlay.js'), 'utf8');
const devSrc = fs.readFileSync(path.join(REPO_ROOT, 'tools', 'dev-server', 'index.mjs'), 'utf8');
assert.match(indexSrc, /route\('\/dsh-l2d\/api\/actions'/);
assert.match(indexSrc, /handleActionsRequest\(req\.method\)/);
assert.match(overlaySrc, /fetch\('\/dsh-l2d\/api\/actions'/);
assert.ok(!/fetch\('\/api\/actions'/.test(overlaySrc), 'overlay 不再用根路径');
assert.match(devSrc, /from '\.\.\/\.\.\/packages\/dsh-l2d-plugin\/lib\/actions-api\.mjs'/);
assert.match(devSrc, /urlPath\.startsWith\('\/dsh-l2d\/'\)[\s\S]{0,120}urlPath = urlPath\.slice\('\/dsh-l2d'\.length\)/);
assert.match(devSrc, /urlPath === '\/api\/actions'/);

// 真实 dev-server：/dsh-l2d/api/actions 与 /api/actions 都能用，数据同一份；/ai/poll 默认带租约
{
  const port = await new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'tools', 'dev-server', 'index.mjs'), '--port', String(port)], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, DSH_L2D_ACTIONS_DB: dbFile, DSH_L2D_ACTIONS_MODEL_ID: '大肥鱼.dsl2d' },
  });
  try {
    let ready = false;
    for (let i = 0; i < 150 && !ready; i++) {
      try { ready = (await fetch(base + '/api/models')).status === 200; } catch { /* 未就绪 */ }
      if (!ready) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(ready, 'dev-server 未就绪');
    const a = await (await fetch(base + '/dsh-l2d/api/actions')).json();
    const b = await (await fetch(base + '/api/actions')).json();
    assert.deepEqual(a, b);
    assert.deepEqual(a.actions.map((r) => r.semanticKey), ['nod', 'wave']);
    const none = await (await fetch(base + '/dsh-l2d/ai/poll')).json();
    assert.equal(none.reason, 'no-lease', '不带实例 id 的 poll 拿不到租约');
    const got = await (await fetch(base + '/dsh-l2d/ai/poll?consumer=t1&fg=1')).json();
    assert.ok(got.lease && got.lease.token);
    assert.equal((await (await fetch(base + '/dsh-l2d/ai/poll?consumer=t2&fg=0')).json()).reason, 'no-lease');
  } finally {
    child.kill();
  }
}
console.log('actions-api ok');
