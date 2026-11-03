#!/usr/bin/env node
/**
 * 把标定截图（*-face.png）拼成一张带标签的对照图，便于一次 read_image 判读。
 * 用法：node sheet.mjs <outDir> [--cols 2] [--out sheet.png]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire('D:/Desktop/DSH-L2D/package.json');
let sharp;
try {
  sharp = req('sharp');
} catch {
  sharp = createRequire(import.meta.url)('sharp');
}

const dir = path.resolve(process.argv[2] || 'out-pilot2');
const cols = Number(process.argv[process.argv.indexOf('--cols') + 1]) || 2;
const outPath = path.join(dir, 'sheet.png');

const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('-face.png'))
  .sort();

const CELL_W = 720;
const CELL_H = 336;
const LABEL_H = 36;

const cells = [];
for (const f of files) {
  const buf = await sharp(path.join(dir, f))
    .resize({ width: CELL_W, height: CELL_H, fit: 'cover' })
    .png()
    .toBuffer();
  cells.push({ file: f, buf });
}

const rows = Math.ceil(cells.length / cols);
const W = cols * CELL_W;
const H = rows * (CELL_H + LABEL_H);

const composites = [];
cells.forEach((c, i) => {
  const x = (i % cols) * CELL_W;
  const y = Math.floor(i / cols) * (CELL_H + LABEL_H);
  const label = c.file.replace('-face.png', '');
  composites.push({ input: c.buf, left: x, top: y + LABEL_H });
  const svg = `<svg width="${CELL_W}" height="${LABEL_H}"><rect width="100%" height="100%" fill="#1b1b1b"/><text x="8" y="25" font-family="Consolas, monospace" font-size="24" fill="#fff">${label}</text></svg>`;
  composites.push({ input: Buffer.from(svg), left: x, top: y });
});

await sharp({ create: { width: W, height: H, channels: 3, background: '#1b1b1b' } })
  .composite(composites)
  .png()
  .toFile(outPath);
console.log(outPath, W + 'x' + H);
