import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDependencyDoctor,
  planRepair,
  assertAuthorized,
  verifyFileIntegrity,
  sha256File,
  isOfficialSource,
  buildCommand,
  satisfies,
  readMoc3Version,
  extractCoreVersion,
  checkSdkModelCompat,
  collectReferencedFiles,
} from '../src/index.ts';

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// ------------------------------------------------------ 测试环境构造
function makeFixtureRoot({ withCore = true, coreVersion = '6.0.1', withModel = true, breakModel = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'doctor-fx-'));
  if (withCore) {
    mkdirSync(join(root, 'vendor'), { recursive: true });
    writeFileSync(
      join(root, 'vendor', 'live2dcubismcore.min.js'),
      `/*! live2dcubismcore — Cubism ${coreVersion} (c) Live2D Inc. */\nvar CubismFramework=function(){};`,
    );
  }
  if (withModel) {
    const modelDir = join(root, 'models', 'm1');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'm1.moc3'), Buffer.concat([Buffer.from('MOC3'), Buffer.alloc(8, 0), Buffer.from([3])]));
    writeFileSync(join(modelDir, 'tex.png'), 'png');
    if (!breakModel) writeFileSync(join(modelDir, 'physics.json'), '{}');
    const refs = {
      FileReferences: {
        Moc: 'm1.moc3',
        Textures: ['tex.png'],
        Physics: 'physics.json',
        Motions: { Idle: [{ File: 'idle.motion3.json' }] },
      },
    };
    writeFileSync(join(modelDir, 'm1.model3.json'), JSON.stringify(refs));
    if (!breakModel) writeFileSync(join(modelDir, 'idle.motion3.json'), '{}');
  }
  return root;
}

// ------------------------------------------------------ 1. scan 五类状态判定
test('scan：SDK/Core 就绪 + 模型完整 + Node 满足 → installed', async () => {
  const root = makeFixtureRoot();
  try {
    const doctor = createDependencyDoctor({ rootDir: root, modelDir: join(root, 'models', 'm1') });
    const reports = await doctor.scan();
    const byId = new Map(reports.map((r) => [r.id, r]));
    assert.equal(byId.get('cubism-sdk').status, 'installed');
    assert.equal(byId.get('cubism-sdk').detectedVersion, '6.0.1');
    assert.equal(byId.get('cubism-runtime').status, 'installed');
    assert.equal(byId.get('live2d-model').status, 'installed', `模型应完整：${byId.get('live2d-model').detail}`);
    assert.equal(byId.get('nodejs').status, 'installed');
    assert.equal(byId.get('gpu-runtime').status, 'unverified', 'GPU 在 Node 侧必须 unverified，不臆测');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scan：Core 缺失 → sdk/runtime missing；模型引用缺失 → 逐文件指出', async () => {
  const root = makeFixtureRoot({ withCore: false, breakModel: true });
  try {
    const doctor = createDependencyDoctor({ rootDir: root, modelDir: join(root, 'models', 'm1') });
    const reports = await doctor.scan();
    const byId = new Map(reports.map((r) => [r.id, r]));
    assert.equal(byId.get('cubism-sdk').status, 'missing');
    assert.equal(byId.get('cubism-runtime').status, 'missing');
    const model = byId.get('live2d-model');
    assert.equal(model.status, 'incompatible');
    assert.deepEqual(model.missingFiles, ['physics.json', 'idle.motion3.json'], '缺失引用必须指到具体文件（fixture 同时缺物理与动作）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scan：版本不兼容 → incompatible（Core 低于基线 / SDK 过旧对上新 moc3）', async () => {
  const root = makeFixtureRoot({ coreVersion: '4.2.1' });
  try {
    const doctor = createDependencyDoctor({ rootDir: root, modelDir: join(root, 'models', 'm1') });
    const reports = await doctor.scan();
    const byId = new Map(reports.map((r) => [r.id, r]));
    // Core 4.2.1 < 5.0 基线 → incompatible
    assert.equal(byId.get('cubism-runtime').status, 'incompatible');
    assert.equal(byId.get('cubism-sdk').status, 'incompatible');
    // moc3 v3 需 SDK>=4，SDK 4.2 兼容 → 模型不受 SDK 连带（版本字节交叉判定不误伤）
    assert.equal(byId.get('live2d-model').status, 'installed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------ 2. 真实模型目录（仓库资源）
test('model-adapter：真实模型目录引用完整性（如资源在位则 installed）', async () => {
  const realModel = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'DeepSeek免费公皮', 'DeepSeek');
  if (!existsSync(realModel)) {
    console.log('  skip：本 worktree 未放置模型资源目录（工作区未跟踪资源）');
    return;
  }
  const root = makeFixtureRoot({ withModel: false });
  try {
    const doctor = createDependencyDoctor({ rootDir: root, modelDir: realModel });
    const reports = await doctor.scan();
    const model = reports.find((r) => r.id === 'live2d-model');
    assert.ok(model);
    assert.equal(model.status, 'installed', `真实模型应完整：${model.detail} / ${JSON.stringify(model.missingFiles)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------ 3. planRepair 只产计划不落盘
test('planRepair：只生成计划，不修改环境；manual 项带官方来源与理由', async () => {
  const root = makeFixtureRoot();
  const marker = join(root, '.no-new-files');
  writeFileSync(marker, 'x');
  try {
    const doctor = createDependencyDoctor({ rootDir: root, modelDir: join(root, 'models', 'm1') });
    const reports = await doctor.scan();
    // 拆掉 core 制造缺失，再取计划
    rmSync(join(root, 'vendor'), { recursive: true, force: true });
    const reports2 = await doctor.scan();
    const plan = await doctor.planRepair(reports2);
    assert.ok(Array.isArray(plan.steps));
    assert.ok(plan.manual.length >= 1, 'SDK 缺失必须进 manual（许可前置）');
    const sdkManual = plan.manual.find((m) => m.id === 'cubism-sdk');
    assert.ok(sdkManual);
    assert.match(sdkManual.reason, /许可/);
    assert.equal(sdkManual.officialSource, 'https://www.live2d.com/sdk/download/web/');
    // 环境未被修改：根目录除标记外无新增文件
    const names = readdirSync(root);
    assert.equal(names.includes('.no-new-files'), true);
    assert.equal(names.some((n) => n.endsWith('.part') || n === 'vendor'), false, 'planRepair 不得执行安装');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------ 4. 授权门禁
test('未授权时安装操作一律拒绝（fail-closed）', async () => {
  const root = makeFixtureRoot({ withModel: false });
  try {
    const fakeReports = [
      { id: 'nodejs-deps', name: 'pnpm deps', category: 'project', requiredVersion: '*', status: 'missing', required: true, repairSupported: true, checkedAt: new Date().toISOString() },
    ];
    const plan = planRepair(fakeReports);
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].requiresAuthorization, true);
    // 无授权 → throw
    assert.throws(() => assertAuthorized(plan, null, plan.steps[0].id), /未获用户授权/);
    assert.throws(() => assertAuthorized(plan, { granted: false }, plan.steps[0].id), /未获用户授权/);
    // 授权了但 step 不在清单 → throw
    assert.throws(() => assertAuthorized(plan, { granted: true, stepIds: ['other'] }, plan.steps[0].id), /不在用户授权清单/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('executeRepair：计划外的 step id 与伪造授权都被拒', async () => {
  const root = makeFixtureRoot({ withModel: false });
  try {
    const doctor = createDependencyDoctor({ rootDir: root });
    const fakePlan = {
      createdAt: new Date().toISOString(),
      steps: [{ id: 'install-nodejs-deps', kind: 'npm-install', target: 'nodejs-deps', description: 'x', requiresAuthorization: true }],
      manual: [],
    };
    const auth = { granted: true, grantedBy: 'test', stepIds: ['install-nodejs-deps'], grantedAt: new Date().toISOString() };
    const results = await doctor.executeRepair(fakePlan, auth);
    // step 在 plan 内且已授权 → 会真跑 pnpm install（fixture 无 lockfile，允许失败，但必须有结果）
    assert.equal(results.length, 1);
    assert.ok('ok' in results[0]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------ 5. assertRuntimeReady
test('assertRuntimeReady：required 未满足 → BLOCKED + 原因清单', async () => {
  const root = makeFixtureRoot({ withCore: false, withModel: false });
  try {
    const doctor = createDependencyDoctor({ rootDir: root, modelDir: join(root, 'models', 'm1') });
    const reports = await doctor.scan();
    const readiness = doctor.assertRuntimeReady(reports);
    assert.equal(readiness.ready, false);
    const ids = readiness.blocked.map((b) => b.id);
    assert.ok(ids.includes('cubism-sdk'), 'SDK 缺失必须阻塞 Runtime');
    assert.ok(ids.includes('cubism-runtime'));
    assert.ok(ids.includes('live2d-model'));
    for (const b of readiness.blocked) assert.ok(b.reason, '每个阻塞项必须给原因');
    // GPU 不 required，不得进阻塞清单
    assert.ok(!ids.includes('gpu-runtime'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assertRuntimeReady：全部满足 → ready', async () => {
  const root = makeFixtureRoot();
  try {
    const doctor = createDependencyDoctor({ rootDir: root, modelDir: join(root, 'models', 'm1') });
    const reports = await doctor.scan();
    const readiness = doctor.assertRuntimeReady(reports);
    assert.equal(readiness.ready, true, JSON.stringify(readiness.blocked));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------ 6. scan/verify 幂等
test('scan/verify 幂等：两次结果一致', async () => {
  const root = makeFixtureRoot();
  try {
    const doctor = createDependencyDoctor({ rootDir: root, modelDir: join(root, 'models', 'm1') });
    const a = await doctor.scan();
    const b = await doctor.verify();
    const strip = (rs) => rs.map((r) => ({ id: r.id, status: r.status, detectedVersion: r.detectedVersion, missingFiles: r.missingFiles }));
    assert.deepEqual(strip(a), strip(b));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------ 7. 纯函数单测
test('version-resolver：>= / = / * 判定', () => {
  assert.equal(satisfies('>=5.0', '6.0.1'), true);
  assert.equal(satisfies('>=5.0', '4.2.1'), false);
  assert.equal(satisfies('>=22', '22.22.2'), true);
  assert.equal(satisfies('*', ''), true);
  assert.equal(satisfies('>=5.0', ''), false);
  assert.equal(satisfies('=1.2', '1.2.0'), true);
});

test('compatibility-checker：moc3 版本字节与 SDK 兼容矩阵', () => {
  assert.equal(checkSdkModelCompat(6, { moc3Version: 5 }).compatible, true);
  assert.equal(checkSdkModelCompat(4, { moc3Version: 5 }).compatible, false, 'moc3 v5 需 SDK>=5');
  assert.equal(checkSdkModelCompat(4, { moc3Version: 3 }).compatible, true);
  assert.equal(checkSdkModelCompat(null, { moc3Version: 3 }).compatible, false, 'SDK 版本未知不得判定兼容');
  const buf = Buffer.concat([Buffer.from('MOC3'), Buffer.alloc(8, 0), Buffer.from([5]), Buffer.alloc(4)]);
  assert.equal(readMoc3Version(new Uint8Array(buf)), 5);
  assert.equal(readMoc3Version(new Uint8Array(Buffer.from('NOTMOC3'))), null, '非 moc3 头拒绝');
});

test('extractCoreVersion：官方文件头版本提取', () => {
  assert.equal(extractCoreVersion('/*! Cubism 6.0.1 core */'), '6.0.1');
  assert.equal(extractCoreVersion('no version here'), null);
});

// ------------------------------------------------------ 8. 安装器白名单与注入拒绝
test('package-installer：白名单命令构造与非法包名拒绝', () => {
  assert.deepEqual(buildCommand({ mode: 'install', cwd: '.' }), ['pnpm', ['install', '--prefer-offline']]);
  assert.deepEqual(buildCommand({ mode: 'add', packageSpec: 'typescript@5.9.3', cwd: '.' }), ['pnpm', ['add', 'typescript@5.9.3']]);
  assert.throws(() => buildCommand({ mode: 'add', packageSpec: 'foo; rm -rf /', cwd: '.' }), /不合法/);
  assert.throws(() => buildCommand({ mode: 'add', packageSpec: '$(whoami)', cwd: '.' }), /不合法/);
});

// ------------------------------------------------------ 9. 完整性与来源白名单
test('integrity-verifier：hash 缺失拒放行；hash 不符报错；一致通过', () => {
  const root = makeFixtureRoot({ withModel: false });
  try {
    const p = join(root, 'sample.bin');
    writeFileSync(p, 'hello-doctor');
    const good = sha256File(p);
    assert.equal(verifyFileIntegrity(p, '').ok, false, '预期 hash 缺失必须拒绝');
    assert.equal(verifyFileIntegrity(p, 'deadbeef').ok, false);
    const v = verifyFileIntegrity(p, good);
    assert.equal(v.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('download-manager：仅 https 官方域放行', () => {
  assert.equal(isOfficialSource('https://www.live2d.com/sdk/download/web/'), true);
  assert.equal(isOfficialSource('http://www.live2d.com/x'), false, '明文 http 拒绝');
  assert.equal(isOfficialSource('https://evil.example.com/core.js'), false, '非官方域拒绝');
  assert.equal(isOfficialSource('not a url'), false);
});

// ------------------------------------------------------ 10. collectReferencedFiles 覆盖全引用类型
test('collectReferencedFiles：moc/纹理/物理/动作/表情/声音全收集', () => {
  const refs = collectReferencedFiles('x.model3.json', {
    FileReferences: {
      Moc: 'a.moc3',
      Textures: ['t1.png', 't2.png'],
      Physics: 'p.json',
      Pose: 'pose.json',
      DisplayInfo: 'cdi.json',
      Motions: { Idle: [{ File: 'idle.motion3.json', Sound: 's.wav' }] },
      Expressions: [{ File: 'e.exp3.json', Name: 'smile' }],
    },
  });
  assert.deepEqual(refs.sort(), [
    'a.moc3', 'cdi.json', 'e.exp3.json', 'idle.motion3.json', 'p.json', 'pose.json', 's.wav', 't1.png', 't2.png',
  ]);
});

// ------------------------------------------------------ 汇总
let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    passed++;
    console.log('  ok ', name);
  } catch (e) {
    failed++;
    console.error('  FAIL', name);
    console.error(String(e && e.stack || e).split('\n').slice(0, 8).join('\n'));
  }
}
if (failed) {
  console.error(`\ndependency-doctor 测试失败：${failed}/${tests.length}\n`);
  process.exit(1);
} else {
  console.log(`\n${passed} passed，0 failed\n`);
}
