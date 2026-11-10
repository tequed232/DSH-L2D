/**
 * [#28] 登记补丁测试：临时模型目录（miku 形态）→ 写回 FileReferences → 幂等 →
 * 其他字段保留 → dry-run 不写盘。
 * 运行：node tools/model-resources/register.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'register.mjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-l2d-register-'));
try {
  // miku 形态：tab 缩进、FileReferences 无 Expressions/Motions、有 Groups。
  fs.writeFileSync(
    path.join(dir, 'miku.model3.json'),
    JSON.stringify(
      {
        Version: 3,
        FileReferences: { Moc: 'miku.moc3', Textures: ['miku.4096/texture_00.png'], Physics: 'miku.physics3.json' },
        Groups: [{ Target: 'Parameter', Name: 'LipSync', Ids: [] }],
      },
      null,
      '\t',
    ),
  );
  for (const f of ['脸红.exp3.json', '唱歌.exp3.json', 'Scene1.motion3.json', 'TapBody_01.motion3.json', 'TapBody_02.motion3.json']) {
    fs.writeFileSync(path.join(dir, f), '{}');
  }

  const out1 = execFileSync(process.execPath, [SCRIPT, '--model-dir', dir], { encoding: 'utf8' });
  assert.match(out1, /表情 \+2（唱歌, 脸红）/);
  assert.match(out1, /动作 \+3（Scene1:Scene1\.motion3\.json, TapBody:TapBody_01\.motion3\.json, TapBody:TapBody_02\.motion3\.json）/);

  const registered = JSON.parse(fs.readFileSync(path.join(dir, 'miku.model3.json'), 'utf8'));
  assert.deepEqual(registered.FileReferences.Expressions, [
    { Name: '唱歌', File: '唱歌.exp3.json' },
    { Name: '脸红', File: '脸红.exp3.json' },
  ]);
  assert.deepEqual(registered.FileReferences.Motions.Scene1, [{ File: 'Scene1.motion3.json' }]);
  assert.deepEqual(registered.FileReferences.Motions.TapBody, [
    { File: 'TapBody_01.motion3.json' },
    { File: 'TapBody_02.motion3.json' },
  ]);
  // 其他字段原样保留
  assert.equal(registered.FileReferences.Moc, 'miku.moc3');
  assert.deepEqual(registered.Groups, [{ Target: 'Parameter', Name: 'LipSync', Ids: [] }]);
  // tab 缩进风格保留
  assert.match(fs.readFileSync(path.join(dir, 'miku.model3.json'), 'utf8'), /^\t/m);
  // 没有临时文件残留（原子写）
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp-register-')), []);

  // 幂等：重跑 added=0
  const out2 = execFileSync(process.execPath, [SCRIPT, '--model-dir', dir], { encoding: 'utf8' });
  assert.match(out2, /无缺登记（幂等）/);

  // 已声明条目不重复：手写一个已带 Expressions 的模型 + 一个新 exp3 → 只补缺的
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-l2d-register-'));
  try {
    fs.writeFileSync(
      path.join(dir2, 'a.model3.json'),
      JSON.stringify({ FileReferences: { Expressions: [{ Name: '已有', File: '已有.exp3.json' }] } }),
    );
    fs.writeFileSync(path.join(dir2, '已有.exp3.json'), '{}');
    fs.writeFileSync(path.join(dir2, '新增.exp3.json'), '{}');
    execFileSync(process.execPath, [SCRIPT, '--model-dir', dir2], { encoding: 'utf8' });
    const a = JSON.parse(fs.readFileSync(path.join(dir2, 'a.model3.json'), 'utf8'));
    assert.deepEqual(a.FileReferences.Expressions, [
      { Name: '已有', File: '已有.exp3.json' },
      { Name: '新增', File: '新增.exp3.json' },
    ]);
  } finally {
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  // dry-run：不写盘
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-l2d-register-'));
  try {
    fs.writeFileSync(path.join(dir3, 'b.model3.json'), JSON.stringify({ FileReferences: { Moc: 'b.moc3' } }));
    fs.writeFileSync(path.join(dir3, '脸红.exp3.json'), '{}');
    const out3 = execFileSync(process.execPath, [SCRIPT, '--model-dir', dir3, '--dry-run'], { encoding: 'utf8' });
    assert.match(out3, /dry-run 未写盘/);
    const after = fs.readFileSync(path.join(dir3, 'b.model3.json'), 'utf8');
    assert.equal(after, JSON.stringify({ FileReferences: { Moc: 'b.moc3' } }), 'dry-run 不改写 model3.json');
  } finally {
    fs.rmSync(dir3, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('register ok');
