#!/usr/bin/env node
/**
 * DSH-L2D 纹理降档
 *
 * 问题：大肥鱼原包 5 张图集合计 592MB 显存，含一张 8192×8192（256MB）。
 * 浏览器/移动端无法承受，会直接崩标签页或创建纹理失败。
 *
 * 做法：等比例缩放图集并改写 model3.json 的 Textures 指向。
 * Live2D 的 UV 是归一化的，整张图集等比缩放不会破坏贴图映射。
 *
 * 用法：
 *   node tools/texture-opt/index.mjs "<模型目录>" [--model3 文件名] [--max 2048] [--out dsl2d-2k]
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const dir = args[0];
const getArg = (name, dflt) => {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : dflt;
};

if (!dir) {
  console.error('用法: node tools/texture-opt/index.mjs "<模型目录>" [--model3 x.model3.json] [--max 2048] [--out 目录名]');
  process.exit(1);
}

const MODEL_DIR = path.resolve(dir);
const MAX = Number(getArg('--max', '2048'));
const OUT_DIR = getArg('--out', `dsl2d-${MAX}`);
const OUT_ABS = path.join(MODEL_DIR, OUT_DIR);

const model3Name = getArg('--model3', null) ||
  fs.readdirSync(MODEL_DIR).find((f) => f.endsWith('.dsl2d.model3.json')) ||
  fs.readdirSync(MODEL_DIR).find((f) => f.endsWith('.model3.json'));

const model3Path = path.join(MODEL_DIR, model3Name);
const model3 = JSON.parse(fs.readFileSync(model3Path, 'utf8'));
const textures = model3.FileReferences?.Textures ?? [];

if (!textures.length) {
  console.error('model3.json 中没有 Textures');
  process.exit(2);
}

fs.mkdirSync(OUT_ABS, { recursive: true });

let beforeMB = 0;
let afterMB = 0;
const rewritten = [];

console.log(`\n模型: ${model3Name}`);
console.log(`目标: 最长边 ${MAX}px → ${OUT_DIR}/\n`);

for (const rel of textures) {
  const src = path.join(MODEL_DIR, rel);
  if (!fs.existsSync(src)) {
    console.warn(`  跳过（不存在）: ${rel}`);
    rewritten.push(rel);
    continue;
  }
  const meta = await sharp(src).metadata();
  const before = (meta.width * meta.height * 4) / 1048576;
  beforeMB += before;

  const scale = Math.min(1, MAX / Math.max(meta.width, meta.height));
  const w = Math.round(meta.width * scale);
  const h = Math.round(meta.height * scale);

  const base = path.basename(rel);
  const outRel = `${OUT_DIR}/${base}`;
  const outAbs = path.join(MODEL_DIR, outRel);

  await sharp(src)
    .resize(w, h, { fit: 'fill', kernel: 'lanczos3' })
    .png({ compressionLevel: 9, palette: false })
    .toFile(outAbs);

  const after = (w * h * 4) / 1048576;
  afterMB += after;
  const diskMB = +(fs.statSync(outAbs).size / 1048576).toFixed(1);

  console.log(
    `  ${base.padEnd(16)} ${meta.width}×${meta.height} → ${w}×${h}   ` +
      `显存 ${before.toFixed(0)}MB → ${after.toFixed(0)}MB   磁盘 ${diskMB}MB`,
  );
  rewritten.push(outRel);
}

// 生成指向降档图集的 model3，其余字段原样保留
const outModel3Name = model3Name.replace(/\.model3\.json$/, `.${MAX}.model3.json`);
const outModel3 = structuredClone(model3);
outModel3.FileReferences.Textures = rewritten;
fs.writeFileSync(path.join(MODEL_DIR, outModel3Name), JSON.stringify(outModel3, null, '\t'), 'utf8');

console.log(`\n显存合计 ${beforeMB.toFixed(0)}MB → ${afterMB.toFixed(0)}MB（降低 ${(100 - (afterMB / beforeMB) * 100).toFixed(0)}%）`);
console.log(`已生成: ${outModel3Name}\n`);
