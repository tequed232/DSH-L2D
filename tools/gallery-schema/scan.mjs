#!/usr/bin/env node
/**
 * 图库盘点扫描器（可复现）
 *
 * 用途：把外部参考图库目录登记进统一 SQLite 注册表（gallery_items，迁移 v2）。
 * 原则：
 *  - 真实格式以魔数嗅探为准，与扩展名不符是事实不是错误（如实记录 real_format + ext）；
 *  - source_class 由文件名启发式分类，一律 review_state='pending'，终判留给视觉标注；
 *  - 幂等：重复运行=更新同一行，不产生重复登记；
 *  - 不改动源文件，只读。
 *
 * 用法：node tools/gallery-schema/scan.mjs <图库目录> [--db <数据库路径>]
 * 输出：<data>/gallery-inventory.json + stdout 摘要
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb } from '../../packages/dsh-l2d-db/src/db.mjs';
import { upsertGalleryItem, gallerySnapshot } from '../../packages/dsh-l2d-db/src/repo.mjs';

const args = process.argv.slice(2);
const dirIdx = args.findIndex((a) => !a.startsWith('--'));
const dir = args[dirIdx];
if (!dir) {
  console.error('用法：node tools/gallery-schema/scan.mjs <图库目录> [--db <数据库路径>]');
  process.exit(2);
}
const dbIdx = args.indexOf('--db');
const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : null;

// ---------------------------------------------------------------- 魔数嗅探

function sniff(head) {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.length >= 6 && (head.subarray(0, 6).toString('latin1') === 'GIF87a' || head.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'gif';
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = head.subarray(8, 12).toString('latin1').toLowerCase();
    if (brand.startsWith('hei') || brand.startsWith('mif1') || brand.startsWith('heic')) return 'heic';
    if (brand.startsWith('avi')) return 'avif';
    return 'isobmff';
  }
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return 'unknown';
}

function pngSize(head) {
  if (head.length < 24) return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

function gifSize(head) {
  if (head.length < 10) return null;
  return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
}

function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  return null;
}

function webpSize(buf) {
  if (buf.length < 30) return null;
  const chunk = buf.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const b = buf.subarray(21, 25);
    return { width: 1 + (((b[1] & 0x3f) << 8) | b[0]), height: 1 + (((b[3] & 0xf) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6)) };
  }
  return null; // VP8X/扩展型留空，视觉标注阶段补
}

// ---------------------------------------------------------------- 启发式分类

const RULES = [
  [/character[-_]sheet|设定|三视图/i, 'character_sheet'],
  [/bili_poster/i, 'poster'],
  [/^Screenshot_|^heybox_/i, 'screenshot'],
  [/^(comment_|IMG_|mmexport|pic_|Image_\d|20260426-|2FE4DF|A251956|CFFFB9)/i, 'photo'],
  [/^ChatGPT|^file_0000/i, 'fan_art'],
  [/^[A-Z]{2}[A-Za-z0-9]{10,}\.(jpg|jpeg)$/i, 'fan_art'], // X/Twitter 图床命名
];

const normExt = (e) => (e === 'jpg' || e === 'jpe' ? 'jpeg' : e === 'tif' ? 'tiff' : e);

function classify(fileName, realFormat) {
  if (realFormat === 'gif') return 'gif_reference';
  for (const [re, cls] of RULES) if (re.test(fileName)) return cls;
  return 'other';
}

// ---------------------------------------------------------------- 主流程

const absDir = path.resolve(dir);
if (!fs.statSync(absDir).isDirectory()) {
  console.error(`不是目录：${absDir}`);
  process.exit(2);
}
const db = openDb(dbPath ? { path: dbPath } : { startDir: process.cwd() });

const items = [];
for (const name of fs.readdirSync(absDir)) {
  const p = path.join(absDir, name);
  if (!fs.statSync(p).isFile()) continue;
  const buf = fs.readFileSync(p);
  const realFormat = sniff(buf.subarray(0, 32));
  let dims = null;
  if (realFormat === 'png') dims = pngSize(buf);
  else if (realFormat === 'gif') dims = gifSize(buf);
  else if (realFormat === 'jpeg') dims = jpegSize(buf);
  else if (realFormat === 'webp') dims = webpSize(buf);
  const ext = path.extname(name).replace(/^\./, '').toLowerCase();
  const sourceClass = classify(name, realFormat);
  const row = upsertGalleryItem(db, {
    fileName: name,
    realFormat,
    ext,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
    sizeBytes: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    sourceClass,
    reviewState: 'pending',
    notes: realFormat !== normExt(ext) ? `扩展名与真实格式不符（实为 ${realFormat}）` : null,
  });
  items.push({ id: row.id, fileName: name, realFormat, ext, ...dims, sizeBytes: buf.length, sourceClass, reviewState: row.review_state });
}

const snapshot = gallerySnapshot(db);
const report = {
  scannedDir: absDir,
  scannedAt: new Date().toISOString(),
  fileCount: items.length,
  totalBytes: items.reduce((s, i) => s + i.sizeBytes, 0),
  formatHistogram: items.reduce((m, i) => { m[i.realFormat] = (m[i.realFormat] ?? 0) + 1; return m; }, {}),
  classHistogram: items.reduce((m, i) => { m[i.sourceClass] = (m[i.sourceClass] ?? 0) + 1; return m; }, {}),
  extensionMismatch: items.filter((i) => i.realFormat !== normExt(i.ext)).map((i) => ({ fileName: i.fileName, realFormat: i.realFormat, ext: i.ext })),
  registry: snapshot,
};

const outFile = path.resolve('data/gallery-inventory.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ fileCount: report.fileCount, totalMB: +(report.totalBytes / 1e6).toFixed(1), formatHistogram: report.formatHistogram, classHistogram: report.classHistogram, extensionMismatch: report.extensionMismatch.length, report: outFile }, null, 1));
db.close();
