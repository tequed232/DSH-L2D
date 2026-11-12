/**
 * 模型导出接口测试（真实 HTTP，起真 dev-server 子进程）：
 *   GET /dsh-l2d/models/export?modelId=X
 *     - 目录布局（<MODEL_DIR>/<id>/）：整目录递归导出，条目集合与磁盘一致；
 *     - 扁平布局（<MODEL_DIR>/<id>.model3.json）：只导出属于该模型的文件（不夹带别人的贴图）；
 *     - 中文 modelId：Content-Disposition filename* UTF-8 编码（RFC 5987）；
 *     - 越界 modelId → 400 invalid-model-id；不存在 → 404 model-not-found。
 *   round-trip：导出的 zip 用 POST /dsh-l2d/models/import 导入另一个空 MODEL_DIR，
 *   管线 done 且 model3.json 落在模型根顶层（证明导出可回导）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readZipEntries } from '../../packages/dsh-l2d-plugin/lib/zip-reader.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-l2d-export-'));
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

/** 原始二进制请求（导出响应是 zip，不解析 JSON）。 */
function requestRaw(port, method, urlPath, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: { ...(headers || {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
function jsonOf(res) {
  try {
    return JSON.parse(res.buffer.toString('utf8'));
  } catch {
    return null;
  }
}

async function waitState(port, jobId, states, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await requestRaw(port, 'GET', '/dsh-l2d/models/import?jobId=' + encodeURIComponent(jobId));
    last = jsonOf(res);
    if (last && states.includes(last.state)) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('导入任务未在时限内到 ' + states.join('|') + '：' + JSON.stringify(last));
}

async function startServer(port, env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'dev-server', 'index.mjs'), '--port', String(port)], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', (c) => {
    log += String(c);
  });
  child.stderr.on('data', (c) => {
    log += String(c);
  });
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
    if (ok) return { child, log: () => log };
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('dev-server 未在时限内启动，日志：\n' + log.slice(-600));
}

// ---------------------------------------------------------------------------
// 夹具：目录布局模型 + 扁平布局模型 + 中文名模型 + 无关模型
// ---------------------------------------------------------------------------
const root = tmp();
const modelDirA = path.join(root, 'modelA');
fs.mkdirSync(modelDirA, { recursive: true });

const dirModelFiles = {
  'demo-model/demo-model.model3.json': JSON.stringify({ FileReferences: { Moc: 'demo-model.moc3', Textures: ['textures/tex00.png'] } }),
  'demo-model/demo-model.moc3': 'MOC3-BYTES',
  'demo-model/textures/tex00.png': 'PNG-BYTES',
  'demo-model/README.txt': 'extra file inside model dir（整目录导出必须包含）',
};
const flatModelFiles = {
  'flat-model.model3.json': JSON.stringify({ FileReferences: { Moc: 'flat-model.moc3', Textures: ['shared/tex.png'] } }),
  'flat-model.moc3': 'FLAT-MOC3',
  'shared/tex.png': 'FLAT-PNG',
  // 不属于 flat-model 的文件：扁平导出不得夹带
  'other-model/other.model3.json': JSON.stringify({ FileReferences: {} }),
  'other-model/other.moc3': 'OTHER',
};
const zhModelFiles = {
  '大肥鱼测试/大肥鱼测试.model3.json': JSON.stringify({ FileReferences: {} }),
  '大肥鱼测试/大肥鱼测试.moc3': 'ZH-MOC3',
};
for (const [rel, content] of Object.entries({ ...dirModelFiles, ...flatModelFiles, ...zhModelFiles })) {
  const full = path.join(modelDirA, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const modelDirB = path.join(root, 'modelB');
fs.mkdirSync(modelDirB, { recursive: true });
const scanOut = path.join(root, 'scan-out');
const dbPath = path.join(root, 'cognition.sqlite');

const portA = await freePort();
const portB = await freePort();
let serverA = null;
let serverB = null;

// 导入管线会在仓库 docs/ 下写能力画像 md（scan.mjs 的输出路径固定）：测试后清理
const repoSideEffects = ['demo-model', 'flat-model'].flatMap((id) => [
  path.join(ROOT, 'docs', 'Capability-Profile-' + id + '.md'),
  path.join(ROOT, 'tools', 'capability-scan', 'profile.' + id + '.json'),
]);

try {
  serverA = await startServer(portA, { DSH_L2D_MODEL_DIR: modelDirA });

  // 1) 目录布局导出：条目集合与磁盘文件集合一致
  const dirExport = await requestRaw(portA, 'GET', '/dsh-l2d/models/export?modelId=demo-model');
  assert.equal(dirExport.status, 200, '导出 200：' + dirExport.buffer.toString('utf8').slice(0, 200));
  assert.equal(dirExport.headers['content-type'], 'application/zip');
  assert.equal(Number(dirExport.headers['content-length']), dirExport.buffer.length, 'Content-Length 与实体一致');
  assert.match(
    String(dirExport.headers['content-disposition']),
    /^attachment; filename="model\.zip"; filename\*=UTF-8''demo-model\.zip$/,
    'Content-Disposition 形状（filename + filename*）',
  );
  assert.equal(dirExport.buffer.subarray(0, 4).toString('latin1'), 'PK\x03\x04', '响应以本地文件头魔数开头');
  const dirEntries = readZipEntries(dirExport.buffer);
  assert.deepEqual(
    dirEntries.map((e) => e.name).sort(),
    Object.keys(dirModelFiles).map((p) => p.slice('demo-model/'.length)).sort(),
    '目录导出条目集合 == 该模型目录磁盘文件集合（模型根文件在 zip 根）',
  );
  assert.equal(
    dirEntries.find((e) => e.name === 'textures/tex00.png').data.toString(),
    'PNG-BYTES',
    '导出内容逐字节一致',
  );

  // 2) 扁平布局导出：只含该模型的文件（不夹带 other-model / 目录模型）
  const flatExport = await requestRaw(portA, 'GET', '/dsh-l2d/models/export?modelId=flat-model');
  assert.equal(flatExport.status, 200);
  const flatEntries = readZipEntries(flatExport.buffer).map((e) => e.name).sort();
  assert.deepEqual(flatEntries, ['flat-model.moc3', 'flat-model.model3.json', 'shared/tex.png'], '扁平导出只带本模型引用文件');

  // 3) 中文 modelId：filename* 按 UTF-8 百分号编码
  const zhId = '大肥鱼测试';
  const zhExport = await requestRaw(portA, 'GET', '/dsh-l2d/models/export?modelId=' + encodeURIComponent(zhId));
  assert.equal(zhExport.status, 200);
  assert.equal(
    zhExport.headers['content-disposition'],
    'attachment; filename="model.zip"; filename*=UTF-8\'\'' + encodeURIComponent(zhId) + '.zip',
    '中文模型名 filename* 编码正确',
  );
  assert.deepEqual(
    readZipEntries(zhExport.buffer).map((e) => e.name).sort(),
    ['大肥鱼测试.moc3', '大肥鱼测试.model3.json'],
    '中文条目名往返正常',
  );

  // 4) 越界/不存在：400 / 404
  const badId = await requestRaw(portA, 'GET', '/dsh-l2d/models/export?modelId=' + encodeURIComponent('../etc/passwd'));
  assert.equal(badId.status, 400);
  assert.equal(jsonOf(badId).error, 'invalid-model-id');
  const missing = await requestRaw(portA, 'GET', '/dsh-l2d/models/export?modelId=nope');
  assert.equal(missing.status, 404);
  assert.equal(jsonOf(missing).error, 'model-not-found');
  const noId = await requestRaw(portA, 'GET', '/dsh-l2d/models/export');
  assert.equal(noId.status, 400, '缺 modelId → 400');

  // 5) round-trip：导出的 zip 导入到另一个空模型目录 → 管线 done + model3 落顶层
  serverB = await startServer(portB, {
    DSH_L2D_MODEL_DIR: modelDirB,
    DSH_L2D_IMPORT_SCAN_OUT: scanOut,
    DSH_L2D_DB_PATH: dbPath,
  });
  for (const [modelId, exportRes] of [
    ['demo-model', dirExport],
    ['flat-model', flatExport],
  ]) {
    const importRes = await requestRaw(portB, 'POST', '/dsh-l2d/models/import', {
      body: exportRes.buffer,
      headers: { 'x-filename': encodeURIComponent(modelId + '.zip'), 'content-type': 'application/octet-stream' },
    });
    assert.equal(importRes.status, 202, '导出物可被导入受理：' + importRes.buffer.toString('utf8'));
    const record = await waitState(portB, jsonOf(importRes).jobId, ['done']);
    assert.equal(record.state, 'done', modelId + ' 回导终态 done');
    assert.equal(record.result.modelId, modelId);
    assert.ok(
      fs.existsSync(path.join(modelDirB, modelId + '.model3.json')),
      modelId + ' 回导后 model3.json 落在模型根顶层（既有加载链可发现）',
    );
  }
  // 目录模型的引用资源也完整回导（相对路径保持）
  assert.equal(fs.readFileSync(path.join(modelDirB, 'textures', 'tex00.png'), 'utf8'), 'PNG-BYTES');
  assert.equal(fs.readFileSync(path.join(modelDirB, 'shared', 'tex.png'), 'utf8'), 'FLAT-PNG');

  console.log('models-export route tests passed');
} finally {
  try {
    serverA?.child.kill();
  } catch {
    /* ignore */
  }
  try {
    serverB?.child.kill();
  } catch {
    /* ignore */
  }
  clean(root);
  for (const f of repoSideEffects) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
}
