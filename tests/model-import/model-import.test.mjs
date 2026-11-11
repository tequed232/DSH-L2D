/**
 * model-import 管线测试（execTool 全部注入假实现，不依赖真实 tools/*.mjs 与网络）：
 *   - 正常导入（嵌套单根文件夹 zip 抬升 → 安装到模型根顶层 → switched 语义 →
 *     capabilities 与能力画像产物同源映射 → staging 清理）；
 *   - invalid-model 三种 reason（no-model3 / multi-model3 / bad-json）；
 *   - zip-slip 条目在管线内被拦；
 *   - 409 busy（返回既有 jobId）与取消在步骤边界生效（文件不落盘、staging 清理）；
 *   - 重导入同名模型允许覆盖；异模型文件名冲突拒绝覆盖；
 *   - 同步校验：非 zip / 扩展名 / 大小上限；
 *   - 工具 spawn 失败降级 warnings 不阻塞（capabilities:null）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createModelImporter, ImportError } from '../../packages/dsh-l2d-plugin/lib/model-import.mjs';
import { makeZip, modelZip } from './zip-writer.mjs';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-l2d-model-import-'));
}
function clean(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
function waitTerminal(importer, jobId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const rec = importer._recordRaw(jobId);
      if (rec && ['done', 'error', 'cancelled'].includes(rec.state)) return resolve(rec);
      if (Date.now() > deadline) return reject(new Error('管线未在时限内到终态：' + (rec && rec.state)));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** 假工具箱：scan 产真实形状的 profile（三分类映射源），catalog/register 记录调用。 */
function fakeExecTool(calls) {
  return async (job) => {
    calls.push(job.tool);
    if (job.tool === 'scan') {
      const modelDir = job.args[job.args.indexOf('--model-dir') + 1];
      const outDir = job.args[job.args.indexOf('--out-dir') + 1];
      const model3 = fs.readdirSync(modelDir).find((n) => n.endsWith('.model3.json'));
      const modelId = model3.replace(/\.model3\.json$/, '');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(
        path.join(outDir, 'profile.' + modelId + '.json'),
        JSON.stringify({
          controls: [
            { id: 'head.yaw', status: 'supported' },
            { id: 'arm.wave', status: 'supported' },
            { id: 'face.smile', status: 'approximate' },
            { id: 'leg.cross', status: 'unsupported' },
          ],
        }),
      );
      return { code: 0, stdout: 'ok', stderr: '' };
    }
    return { code: 0, stdout: 'ok', stderr: '' };
  };
}

function makeImporter(opts = {}) {
  const modelDir = opts.modelDir || tmp();
  const scanOutDir = opts.scanOutDir || path.join(modelDir, '..', 'scan-out-' + path.basename(modelDir));
  const calls = [];
  const importer = createModelImporter({
    modelDir,
    repoRoot: opts.repoRoot || tmp(),
    scanOutDir,
    execTool: opts.execTool || fakeExecTool(calls),
    ...(opts.maxZipBytes ? { maxZipBytes: opts.maxZipBytes } : {}),
  });
  return { importer, modelDir, scanOutDir, calls };
}

const terminals = new Set(['done', 'error', 'cancelled']);

// ---------------------------------------------------------------------------
// 1) 正常导入：嵌套 zip 抬升 + 安装到顶层 + capabilities 同源映射 + staging 清理
// ---------------------------------------------------------------------------
{
  const { importer, modelDir, scanOutDir } = makeImporter();
  try {
    const out = importer.beginImport({ filename: 'demo-model.zip', data: modelZip('demo-model') });
    assert.equal(out.ok, true);
    const rec = await waitTerminal(importer, out.jobId);
    assert.equal(rec.state, 'done', '终态应为 done，实际 ' + rec.state + '：' + JSON.stringify(rec.error));
    assert.equal(rec.result.modelId, 'demo-model');
    assert.equal(rec.result.name, 'demo-model');
    assert.deepEqual(
      rec.result.capabilities,
      {
        supports: [{ name: 'head.yaw' }, { name: 'arm.wave' }],
        approximate: [{ name: 'face.smile' }],
        unsupported: [{ name: 'leg.cross' }],
      },
      'capabilities 三分类与能力画像产物同源',
    );
    assert.equal(rec.result.switched, true, '模型根目录从空到有 → 当前模型切换');
    // 安装位置：既有加载链只发现模型根顶层
    assert.ok(fs.existsSync(path.join(modelDir, 'demo-model.model3.json')), 'model3.json 必须落在模型根顶层');
    assert.ok(fs.existsSync(path.join(modelDir, 'demo-model.moc3')));
    assert.ok(fs.existsSync(path.join(modelDir, 'texture00.png')), '嵌套 data/ 内容已抬升');
    // staging 清理
    const stagingRoot = path.join(path.dirname(modelDir), '.l2d-model-import');
    assert.equal(fs.existsSync(stagingRoot) && fs.readdirSync(stagingRoot).length > 0, false, 'staging 已清理');
    assert.ok(fs.existsSync(path.join(scanOutDir, 'profile.demo-model.json')));
  } finally {
    clean(path.dirname(modelDir));
  }
}

// ---------------------------------------------------------------------------
// 2) invalid-model：no-model3 / multi-model3 / bad-json
// ---------------------------------------------------------------------------
for (const [label, entries, reason] of [
  ['no-model3', [{ name: 'readme.txt', data: 'no model here' }], 'no-model3'],
  ['multi-model3', [{ name: 'a.model3.json', data: '{}' }, { name: 'sub/b.model3.json', data: '{}' }], 'multi-model3'],
]) {
  const { importer, modelDir } = makeImporter();
  try {
    const out = importer.beginImport({ filename: 'x.zip', data: makeZip(entries) });
    const rec = await waitTerminal(importer, out.jobId);
    assert.equal(rec.state, 'error', label);
    assert.equal(rec.error.reason, reason, label + ' → reason=' + reason);
    assert.equal(rec.error.code, 422);
    assert.ok(rec.error.message.length > 0, '中文 message 非空');
  } finally {
    clean(path.dirname(modelDir));
  }
}
{
  const { importer, modelDir } = makeImporter();
  try {
    const out = importer.beginImport({ filename: 'x.zip', data: makeZip([{ name: 'bad.model3.json', data: '{oops' }]) });
    const rec = await waitTerminal(importer, out.jobId);
    assert.equal(rec.state, 'error');
    assert.equal(rec.error.reason, 'bad-json');
    assert.equal(rec.error.code, 422);
  } finally {
    clean(path.dirname(modelDir));
  }
}

// ---------------------------------------------------------------------------
// 3) zip-slip 条目在管线内被拦（zip-reader 抛，管线落 error 态）
// ---------------------------------------------------------------------------
{
  const { importer, modelDir } = makeImporter();
  try {
    const zip = makeZip([
      { rawName: '../escaped.txt', data: 'evil' },
      { name: 'm.model3.json', data: '{}' },
    ]);
    const out = importer.beginImport({ filename: 'evil.zip', data: zip });
    const rec = await waitTerminal(importer, out.jobId);
    assert.equal(rec.state, 'error');
    assert.equal(rec.error.reason, 'zip-slip');
    assert.equal(fs.existsSync(path.join(path.dirname(modelDir), 'escaped.txt')), false, '穿越文件不得落盘');
    assert.equal(fs.existsSync(path.join(modelDir, 'escaped.txt')), false);
  } finally {
    clean(path.dirname(modelDir));
  }
}

// ---------------------------------------------------------------------------
// 4) 409 busy：活跃任务存在时拒绝第二个导入，回执带既有 jobId
// ---------------------------------------------------------------------------
{
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const calls = [];
  const { importer, modelDir } = makeImporter({
    execTool: async (job) => {
      calls.push(job.tool);
      if (job.tool === 'scan') await gate; // 卡在 scanning 步，制造活跃窗口
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  try {
    const first = importer.beginImport({ filename: 'a.zip', data: modelZip('demo-model') });
    assert.equal(first.ok, true);
    // 等管线推进到 spawn 之前的窗口即可 busy（extracting 同步写文件后很快到 registering）
    const second = importer.beginImport({ filename: 'b.zip', data: modelZip('other') });
    assert.equal(second.ok, false);
    assert.equal(second.status, 409);
    assert.equal(second.reason, 'busy');
    assert.equal(second.existingJobId, first.jobId, 'busy 回执带既有 jobId');
    release();
    const rec = await waitTerminal(importer, first.jobId);
    assert.equal(rec.state, 'done');
  } finally {
    release();
    clean(path.dirname(modelDir));
  }
}

// ---------------------------------------------------------------------------
// 5) 取消在步骤边界生效：文件不落盘、staging 清理、state=cancelled
// ---------------------------------------------------------------------------
{
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const { importer, modelDir } = makeImporter({
    execTool: async (job) => {
      if (job.tool === 'register') await gate; // 卡在 registering
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  try {
    const out = importer.beginImport({ filename: 'a.zip', data: modelZip('demo-model') });
    // 等到 register 真正开始（gate 被 await）再请求取消
    const deadline = Date.now() + 3000;
    while (importer._recordRaw(out.jobId).step !== 'register-resources' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const cancel = importer.cancel(out.jobId);
    assert.equal(cancel.ok, true);
    assert.equal(cancel.cancelled, true);
    release();
    const rec = await waitTerminal(importer, out.jobId);
    assert.equal(rec.state, 'cancelled', '下一个步骤边界生效取消');
    assert.equal(fs.existsSync(path.join(modelDir, 'demo-model.model3.json')), false, '取消后文件不落盘');
    const stagingRoot = path.join(path.dirname(modelDir), '.l2d-model-import');
    assert.equal(fs.existsSync(stagingRoot) && fs.readdirSync(stagingRoot).length > 0, false, 'staging 已清理');
    // 终态后再取消 → not-cancellable
    const again = importer.cancel(out.jobId);
    assert.equal(again.ok, false);
    assert.equal(again.error, 'not-cancellable');
    assert.equal(again.state, 'cancelled');
  } finally {
    release();
    clean(path.dirname(modelDir));
  }
}

// ---------------------------------------------------------------------------
// 6) 重导入同名模型允许覆盖；异模型文件名冲突拒绝
// ---------------------------------------------------------------------------
{
  const { importer, modelDir } = makeImporter();
  try {
    const first = importer.beginImport({ filename: 'a.zip', data: modelZip('demo-model') });
    await waitTerminal(importer, first.jobId);
    const before = fs.readFileSync(path.join(modelDir, 'texture00.png'));
    const second = importer.beginImport({ filename: 'a.zip', data: modelZip('demo-model') });
    const rec = await waitTerminal(importer, second.jobId);
    assert.equal(rec.state, 'done', '同模型重导入成功');
    assert.deepEqual(fs.readFileSync(path.join(modelDir, 'texture00.png')), before);
  } finally {
    clean(path.dirname(modelDir));
  }
}
{
  const { importer, modelDir } = makeImporter();
  try {
    // 预置另一个模型的同名贴图（内容不同），导入不同 model3 的模型 → 冲突拒绝
    fs.writeFileSync(path.join(modelDir, 'texture00.png'), Buffer.from('existing-other-model'));
    const out = importer.beginImport({
      filename: 'x.zip',
      data: makeZip([
        { name: 'other.model3.json', data: '{}' },
        { name: 'texture00.png', data: Buffer.from('incoming-different') },
      ]),
    });
    const rec = await waitTerminal(importer, out.jobId);
    assert.equal(rec.state, 'error');
    assert.equal(rec.error.reason, 'name-conflict');
    assert.deepEqual(fs.readFileSync(path.join(modelDir, 'texture00.png')), Buffer.from('existing-other-model'), '既有文件未被覆盖');
  } finally {
    clean(path.dirname(modelDir));
  }
}

// ---------------------------------------------------------------------------
// 7) 同步校验：非 zip / 扩展名 / 大小上限（不建任务、不抛注册表副作用）
// ---------------------------------------------------------------------------
{
  const { importer, modelDir } = makeImporter();
  try {
    assert.throws(() => importer.beginImport({ filename: 'a.zip', data: Buffer.from('garbage not zip') }), (err) => err instanceof ImportError && err.code === 'not-zip');
    assert.throws(
      () => importer.beginImport({ filename: 'a.rar', data: makeZip([{ name: 'm.model3.json', data: '{}' }]) }),
      (err) => err instanceof ImportError && err.code === 'not-zip',
      '扩展名必须 .zip',
    );
    const small = makeImporter({ maxZipBytes: 8 });
    assert.throws(() => small.importer.beginImport({ filename: 'a.zip', data: Buffer.from('PK\x03\x04xxxxxxxxxxxx') }), (err) => err instanceof ImportError && err.code === 'too-large');
    assert.equal(importer.get('nonexistent'), null);
    assert.equal(importer.cancel('nonexistent').error, 'not-found');
  } finally {
    clean(path.dirname(modelDir));
  }
}

// ---------------------------------------------------------------------------
// 8) 工具失败降级：register/catalog/scan 全失败 → 导入仍 done，capabilities:null + warnings
// ---------------------------------------------------------------------------
{
  const { importer, modelDir } = makeImporter({ execTool: async () => ({ code: 1, stdout: '', stderr: 'boom' }) });
  try {
    const out = importer.beginImport({ filename: 'a.zip', data: modelZip('demo-model') });
    const rec = await waitTerminal(importer, out.jobId);
    assert.equal(rec.state, 'done', '工具失败不阻塞导入');
    assert.equal(rec.result.capabilities, null, '扫描失败 → capabilities:null');
    assert.ok(rec.result.warnings.some((w) => w.startsWith('scan-')), 'warnings 说明降级原因');
  } finally {
    clean(path.dirname(modelDir));
  }
}

console.log('model-import tests passed');
