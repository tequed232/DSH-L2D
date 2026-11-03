#!/usr/bin/env node
/**
 * 标定截图对照图：按 zoom 区域裁切 + 标签 + 网格拼图，一次 read_image 判读。
 *
 * 用法：
 *   node tools/facial-calibration/montage.mjs --dir <shotDir> --out <dir>/montage.png \
 *     --names name1,name2,... --crop 360,220,760,220 --cols 2 [--scale 1]
 *
 * 输入用 *-face.png（run.mjs 生成的脸部裁切），没有则用整图。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const SHARED = 'D:/Desktop/DSH-L2D';
let sharp = null;
for (const base of [path.join(SHARED, 'package.json'), import.meta.url]) {
  try {
    sharp = createRequire(base)('sharp');
    break;
  } catch {
    /* 试下一个 */
  }
}
if (!sharp) {
  console.error('[montage] 找不到 sharp（在共享 checkout node_modules 里）');
  process.exit(2);
}

const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
};
const DIR = path.resolve(arg('--dir', '.'));
const OUT = path.resolve(arg('--out', path.join(DIR, 'montage.png')));
const NAMES = String(arg('--names', '')).split(',').map((s) => s.trim()).filter(Boolean);
const COLS = Number(arg('--cols', 2));
const SCALE = Number(arg('--scale', 1));
const [cx, cy, cw, ch] = String(arg('--crop', ''))
  .split(',')
  .map((v) => Number(v));
const LABEL_H = 34;

if (!NAMES.length) {
  console.error('[montage] 需要 --names（逗号分隔，按目录里的文件名，不用扩展名）');
  process.exit(2);
}

const cells = [];
for (const name of NAMES) {
  const face = path.join(DIR, name + '-face.png');
  const full = path.join(DIR, name + '.png');
  const src = fs.existsSync(face) ? face : full;
  if (!fs.existsSync(src)) {
    console.error('[montage] 缺少截图: ' + src);
    process.exit(2);
  }
  let img = sharp(src);
  if (Number.isFinite(cx) && Number.isFinite(cy) && cw > 0 && ch > 0) {
    img = img.extract({ left: cx, top: cy, width: cw, height: ch });
  }
  const meta = await sharp(src).metadata();
  const buf = await img.png().toBuffer();
  cells.push({ name, buf, w: cw || meta.width, h: ch || meta.height });
}

const cellW = Math.round(cells[0].w * SCALE);
const cellH = Math.round(cells[0].h * SCALE);
const resized = [];
for (const c of cells) {
  const buf = await sharp(c.buf).resize({ width: cellW }).png().toBuffer();
  resized.push({ ...c, buf });
}
const rows = Math.ceil(resized.length / COLS);
const W = COLS * cellW;
const H = rows * (cellH + LABEL_H);
const comps = [];
resized.forEach((c, i) => {
  const x = (i % COLS) * cellW;
  const y = Math.floor(i / COLS) * (cellH + LABEL_H);
  const svg = `<svg width="${cellW}" height="${LABEL_H}"><rect width="100%" height="100%" fill="#141414"/><text x="6" y="24" font-family="Consolas, monospace" font-size="20" fill="#fff">${c.name}</text></svg>`;
  comps.push({ input: Buffer.from(svg), left: x, top: y });
  comps.push({ input: c.buf, left: x, top: y + LABEL_H });
});
await sharp({ create: { width: W, height: H, channels: 3, background: '#141414' } })
  .composite(comps)
  .png()
  .toFile(OUT);
console.log(OUT + ' ' + W + 'x' + H);
