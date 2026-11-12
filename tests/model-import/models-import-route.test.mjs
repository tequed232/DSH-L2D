/**
 * 模型导入三端点路由测试（真实 HTTP，起真 dev-server 子进程）：
 *   POST /dsh-l2d/models/import（zip 原始字节 + X-Filename）→ 202 {jobId}
 *   GET  /dsh-l2d/models/import?jobId=X → state/step/progress/result/error
 *   POST /dsh-l2d/models/import/cancel {jobId}
 *
 * 用真实 tools/*.mjs 跑通管线（fixture 是最小模型：catalog 因假 moc3 失败属预期降级；
 * scan 会真实产出 profile）。测试自清理临时目录与仓库内的扫描副产物。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeZip, modelZip } from './zip-writer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-l2d-import-route-'));
}
function clean(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function request(port, method, urlPath, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method, headers: { ...(headers || {}) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* 非 JSON（如 405 纯文本） */
          }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitState(port, jobId, states, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await request(port, 'GET', '/dsh-l2d/models/import?jobId=' + encodeURIComponent(jobId));
    last = res.json;
    if (last && states.includes(last.state)) return { res, record: last };
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('任务未在时限内到 ' + states.join('|') + '：' + JSON.stringify(last));
}

// 沙盒根：modelDir/scanOut/db 都嵌在同一个根下（清理只删这个根，绝不 rm 系统临时目录）。
const root = tmp();
const modelDir = path.join(root, 'model');
const scanOut = path.join(root, 'scan-out');
const dbPath = path.join(root, 'cognition.sqlite');
fs.mkdirSync(modelDir, { recursive: true });
const port = await freePort();
const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'dev-server', 'index.mjs'), '--port', String(port)], {
  cwd: ROOT,
  env: {
    ...process.env,
    DSH_L2D_MODEL_DIR: modelDir,
    DSH_L2D_IMPORT_SCAN_OUT: scanOut,
    // C-2 认知入库：DB 指向沙盒，绝不写仓库默认库 data/bootstrap-state.sqlite
    DSH_L2D_DB_PATH: dbPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let serverLog = '';
child.stdout.on('data', (c) => {
  serverLog += String(c);
});
child.stderr.on('data', (c) => {
  serverLog += String(c);
});

// 仓库内扫描副产物（scan.mjs 的 docs 输出路径固定）：测试结束清理
const fixtureId = 'route-e2e-model';
const repoSideEffects = [
  path.join(ROOT, 'tools', 'capability-scan', 'profile.' + fixtureId + '.json'),
  path.join(ROOT, 'docs', 'Capability-Profile-' + fixtureId + '.md'),
];

try {
  // 等 dev-server 监听
  {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const ok = await new Promise((resolve) => {
        const probe = http.request({ host: '127.0.0.1', port, path: '/healthz', method: 'GET', timeout: 800 }, (r) => {
          r.resume();
          resolve(true);
        });
        probe.on('timeout', () => {
          probe.destroy();
          resolve(false);
        });
        probe.on('error', () => resolve(false));
        probe.end();
      });
      if (ok) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // 1) 非法输入：垃圾字节 → 400 not-zip；未知 jobId → 404
  {
    const bad = await request(port, 'POST', '/dsh-l2d/models/import', { body: Buffer.from('garbage') });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'not-zip');
    const missing = await request(port, 'GET', '/dsh-l2d/models/import?jobId=nope');
    assert.equal(missing.status, 404);
    const cancelMissing = await request(port, 'POST', '/dsh-l2d/models/import/cancel', { body: JSON.stringify({ jobId: 'nope' }), headers: { 'content-type': 'application/json' } });
    assert.equal(cancelMissing.status, 404);
    const noId = await request(port, 'GET', '/dsh-l2d/models/import');
    assert.equal(noId.status, 400);
  }

  // 2) 正常导入（真实管线，真实 spawn）：202 → done → 文件落模型根顶层
  let jobId;
  {
    const res = await request(port, 'POST', '/dsh-l2d/models/import', {
      body: modelZip(fixtureId),
      headers: { 'x-filename': encodeURIComponent(fixtureId + '.zip'), 'content-type': 'application/octet-stream' },
    });
    assert.equal(res.status, 202, '受理返回 202：' + res.text);
    assert.equal(res.json.ok, true);
    jobId = res.json.jobId;
    assert.ok(jobId);

    const { record } = await waitState(port, jobId, ['done']);
    assert.equal(record.step, 'done');
    assert.equal(record.progress, 100);
    assert.equal(record.result.modelId, fixtureId);
    assert.equal(record.result.switched, true, '空模型目录 → 导入即当前模型');
    assert.ok(fs.existsSync(path.join(modelDir, fixtureId + '.model3.json')), 'model3.json 落在模型根顶层（既有加载链可发现）');
    // C-2：认知入库（cognition 步）真实执行 —— 沙盒库文件被创建且含本模型行
    assert.ok(fs.existsSync(dbPath), '认知档案库应被创建（cognition 步真实执行）');
    // 最小 fixture：scan 真实执行成功（controls 全 unsupported/unknown），capabilities 与产物同源
    assert.ok(record.result.capabilities, '最小模型 scan 应成功产出 capabilities');
    assert.ok(fs.existsSync(path.join(scanOut, 'profile.' + fixtureId + '.json')));
    // 假 moc3 → catalog 工具失败属预期，降级为 warning 不阻塞
    assert.ok(
      record.result.warnings.some((w) => w.startsWith('catalog-')),
      'catalog 失败应降级 warnings：' + JSON.stringify(record.result.warnings),
    );
  }

  // 3) 任务终态后取消 → 409 not-cancellable；完成后可再次导入（重导入覆盖）
  {
    const cancel = await request(port, 'POST', '/dsh-l2d/models/import/cancel', {
      body: JSON.stringify({ jobId }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(cancel.status, 409);
    assert.equal(cancel.json.error, 'not-cancellable');
    assert.equal(cancel.json.state, 'done');

    const again = await request(port, 'POST', '/dsh-l2d/models/import', {
      body: modelZip(fixtureId),
      headers: { 'x-filename': encodeURIComponent(fixtureId + '.zip') },
    });
    assert.equal(again.status, 202, '终态后同模型重导入受理');
    const { record } = await waitState(port, again.json.jobId, ['done']);
    assert.equal(record.state, 'done');
  }

  // 4) 违规模型包：无 model3.json → error + reason=no-model3（message 中文）
  {
    const res = await request(port, 'POST', '/dsh-l2d/models/import', {
      body: makeZip([{ name: 'readme.txt', data: 'no model' }]),
      headers: { 'x-filename': 'empty.zip' },
    });
    assert.equal(res.status, 202);
    const { record } = await waitState(port, res.json.jobId, ['error']);
    assert.equal(record.error.reason, 'no-model3');
    assert.equal(record.error.code, 422);
    assert.ok(/[\u4e00-\u9fa5]/.test(record.error.message), 'message 中文可读');
  }

  console.log('models-import route tests passed');
} finally {
  child.kill();
  clean(root); // 模型目录 / 扫描产物 / 认知库都在同一个沙盒根下
  for (const f of repoSideEffects) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
  if (serverLog.includes('EADDRINUSE')) {
    console.error('[route-test] dev-server 端口冲突日志：\n' + serverLog.slice(-400));
  }
}
