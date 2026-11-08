/**
 * 功能指纹提取器（与样式无关，只抽取功能契约要素）
 * 用法：
 *   node docs/studio-ui/fingerprint.mjs --write   # 生成/刷新基线
 *   node docs/studio-ui/fingerprint.mjs            # 输出当前指纹 JSON 到 stdout
 * 基线文件：docs/studio-ui/baseline/functional-fingerprint.json
 *
 * 提取要素：id / href / data-* 属性名 / 事件绑定名 / 中文可见文案 / 中文字符串字面量
 * 明确排除：<style> 块、<script> 块、CSS 注释、纯 CSS 字符串。
 * 样式适配允许追加 class、包裹容器、改 CSS 规则，这些都不会改变本指纹。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const baselineFile = path.join(here, 'baseline', 'functional-fingerprint.json');

const explicit = [
  'packages/dsh-l2d-plugin/assets/settings.html',
  'packages/dsh-l2d-plugin/assets/test.html',
  'packages/dsh-l2d-plugin/lib/pet.html',
  'packages/dsh-l2d-plugin/lib/settings-entry.js',
  'packages/dsh-l2d-plugin/lib/overlay.js',
];

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'vendor') continue;
      walk(p, out);
    } else if (e.name.endsWith('.vue')) out.push(p);
  }
  return out;
}

const vueFiles = [
  ...walk(path.join(root, 'apps/stage-web/src/components')),
  ...walk(path.join(root, 'apps/whale-workspace/src/components')),
].map((p) => path.relative(root, p).replace(/\\/g, '/'));

const files = [...new Set([...explicit, ...vueFiles])].filter((f) => fs.existsSync(path.join(root, f)));

const CJK = /[\u4e00-\u9fa5]/;
const CSSISH = /[:{}]|px\b|rem\b|#[0-9a-f]{3,8}\b|rgb\(|var\(|--[a-z]|@media|box-shadow|border-radius/i;

function stripMarkup(text) {
  return text
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
}

function uniqSorted(arr) {
  const m = new Map();
  for (const v of arr) m.set(v, (m.get(v) || 0) + 1);
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([v, n]) => [v, n]);
}

function fingerprint(rel) {
  const raw = fs.readFileSync(path.join(root, rel), 'utf8');
  const isScript = /\.(js|mjs|ts)$/.test(rel);
  const body = isScript ? raw : stripMarkup(raw);
  const ids = [], hrefs = [], events = [], dataAttrs = [], texts = [];

  for (const m of body.matchAll(/\bid\s*=\s*["']([^"'`]+)["']/g)) ids.push(m[1]);
  for (const m of body.matchAll(/\bid\s*:\s*["']([^"'`]+)["']/g)) ids.push(m[1]);
  for (const m of body.matchAll(/\bhref\s*=\s*["']([^"'`]+)["']/g)) hrefs.push(m[1]);
  for (const m of body.matchAll(/\bhref\s*:\s*["']([^"'`]+)["']/g)) hrefs.push(m[1]);
  for (const m of body.matchAll(/\b(data-[a-z0-9-]+)\s*=/g)) dataAttrs.push(m[1]);
  for (const m of body.matchAll(/addEventListener\(\s*["']([a-zA-Z]+)["']/g)) events.push(m[1]);
  for (const m of body.matchAll(/(?:@|v-on:)([a-zA-Z]+)\s*=/g)) events.push(m[1]);
  for (const m of body.matchAll(/\bon([a-z]+)\s*=\s*["']/g)) events.push(m[1]);

  // 可见中文文案（标签之间）
  for (const m of body.matchAll(/>([^<>]*[\u4e00-\u9fa5][^<>]*)</g)) {
    const t = m[1].replace(/\{\{[^}]*\}\}/g, '').trim();
    if (t) texts.push(t);
  }
  // JS 字符串字面量中的中文（排除 CSS 特征串）
  if (isScript) {
    for (const m of raw.matchAll(/(['"`])([^'"`\n]*[\u4e00-\u9fa5][^'"`\n]*)\1/g)) {
      const t = m[2].trim();
      if (t && !CSSISH.test(t) && !/^\/[\/*]/.test(t)) texts.push(t);
    }
  }

  return {
    ids: uniqSorted(ids),
    hrefs: uniqSorted(hrefs),
    dataAttrs: uniqSorted(dataAttrs),
    events: uniqSorted(events),
    texts: uniqSorted(texts),
  };
}

const result = { generatedAt: new Date().toISOString(), files: {} };
for (const f of files.sort()) result.files[f] = fingerprint(f);

if (process.argv.includes('--write')) {
  fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
  fs.writeFileSync(baselineFile, JSON.stringify(result, null, 2) + '\n');
  console.log('BASELINE WRITTEN: ' + path.relative(root, baselineFile));
  for (const [f, v] of Object.entries(result.files)) {
    console.log('  ' + f + '  ids=' + v.ids.length + ' hrefs=' + v.hrefs.length +
      ' data=' + v.dataAttrs.length + ' events=' + v.events.length + ' texts=' + v.texts.length);
  }
} else {
  console.log(JSON.stringify(result, null, 2));
}
