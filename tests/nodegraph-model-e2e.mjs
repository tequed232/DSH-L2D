#!/usr/bin/env node
/**
 * dev-server 端到端取证：apply-ops 按图绑定模型/显式 modelId 选清单。
 * 说明：dev-server 路由未接 catalog 与 ?model=（dev-server 不在本任务所有权内），
 * catalog 与 ?model= 过滤已在 tests/nodegraph-model.test.mjs 的 handler 层全覆盖，
 * 宿主路由（lib/index.js）已接线。本脚本验证共用 handler 在 HTTP 下的行为。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-l2d-mb-e2e-'));
const PORT = 5391;
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ['tools/dev-server/index.mjs', '--port', String(PORT)], {
  cwd: ROOT,
  env: { ...process.env, DSH_HOME: HOME },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (c) => { serverLog += String(c); });
server.stderr.on('data', (c) => { serverLog += String(c); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json, text };
}

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond, detail: detail || '' });
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' | ' + detail : ''));
};

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/core.js'); return; } catch { await sleep(200); }
  }
  throw new Error('dev-server 未就绪: ' + serverLog.slice(-500));
}

try {
  await waitReady();

  // 1) 导入两张图：strict 绑大肥鱼 / any（无绑定）
  const graph = { roots: ['a'], nodes: [{ id: 'a', type: 'expression', name: '脸红', next: [] }] };
  const doc1 = { schemaVersion: 1, kind: 'dsh-l2d-nodegraph', name: 'e2e-strict', modelBinding: { modelId: '大肥鱼.dsl2d.2048', bindingMode: 'strict' }, graph };
  const doc2 = { schemaVersion: 1, kind: 'dsh-l2d-nodegraph', name: 'e2e-any', modelBinding: { bindingMode: 'any' }, graph };
  const imp1 = await req('POST', '/dsh-l2d/nodegraphs/import', doc1);
  const imp2 = await req('POST', '/dsh-l2d/nodegraphs/import', doc2);
  check('导入 strict/any 两张图', imp1.status === 200 && imp2.status === 200);

  // 2) apply-ops 按图绑定模型选清单：脸红（大肥鱼清单内）合法 + modelId 回执
  const ok = await req('POST', '/dsh-l2d/api/nodegraph/apply-ops', { name: 'e2e-strict', ops: [{ op: 'set_param', id: 'a', key: 'name', value: '脸红' }] });
  check('apply-ops 脸红合法 + modelId 回执', ok.status === 200 && ok.json.ok === true && ok.json.modelId === '大肥鱼.dsl2d.2048' && ok.json.live2dIdsSource === 'model', JSON.stringify(ok.json.errors || []));

  // 3) apply-ops：大肥鱼清单外的表情拒绝
  const bad = await req('POST', '/dsh-l2d/api/nodegraph/apply-ops', { name: 'e2e-strict', ops: [{ op: 'set_param', id: 'a', key: 'name', value: 'NoSuchExp' }] });
  check('apply-ops 清单外表情 → unknown-live2d-id', bad.json.ok === false && bad.json.errors[0].reason === 'unknown-live2d-id');

  // 4) 显式 modelId 覆盖图绑定
  const override = await req('POST', '/dsh-l2d/api/nodegraph/apply-ops', { name: 'e2e-strict', ops: [{ op: 'set_param', id: 'a', key: 'name', value: '脸红' }], modelId: 'ghost-model' });
  check('显式 modelId 生效 + 回退全局告警', override.json.ok === true && override.json.modelId === 'ghost-model' && override.json.catalogWarning === 'model-catalog-missing', 'source=' + override.json.live2dIdsSource);

  // 5) 单图回执带 modelId / source
  const single = await req('GET', '/dsh-l2d/api/nodegraph/graph?name=e2e-strict');
  check('graph?name 回执 modelId + source=model', single.json.modelId === '大肥鱼.dsl2d.2048' && single.json.live2dIdsSource === 'model');

  // 6) any 图（无绑定、无当前模型）→ 全局清单兜底
  const anyGet = await req('GET', '/dsh-l2d/api/nodegraph/graph?name=e2e-any');
  check('any 图无绑定 → 全局清单兜底', anyGet.json.live2dIds === 'loaded' && !anyGet.json.modelId, 'source=' + anyGet.json.live2dIdsSource);
} catch (err) {
  check('e2e 异常', false, String(err && err.message));
} finally {
  server.kill();
  await sleep(300);
  fs.rmSync(HOME, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\ne2e done: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
