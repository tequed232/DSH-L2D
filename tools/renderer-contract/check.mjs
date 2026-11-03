#!/usr/bin/env node
/**
 * 渲染包导出契约门禁。
 *
 * 背景（真实事故）：renderer 打包成 UMD 后，页面上的 `window.DSH_L2D` 拿到的是**模块命名空间**，
 * 而 `normalizeActPlan` 当时只写在 default 的 api 对象里、没有具名导出 —— 于是 overlay 里
 * `L.normalizeActPlan` 恒为 undefined，并行组降级/整组超时在浏览器里从未生效，
 * 而 node 测试直接 import 源码，一直是绿的。
 *
 * 因此规则只有一条：**overlay 依赖的每个 L.xxx 都必须是具名导出**（不能只挂在 default 上）。
 * 纯静态检查，不需要构建，也不需要运行实例。
 *
 *   node tools/renderer-contract/check.mjs
 *
 * 退出码：0 通过；1 有缺失；2 文件缺失。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OVERLAY = path.join(ROOT, 'packages', 'dsh-l2d-plugin', 'lib', 'overlay.js');
const RENDERER = path.join(ROOT, 'packages', 'renderer', 'src', 'index.ts');

for (const f of [OVERLAY, RENDERER]) {
  if (!fs.existsSync(f)) {
    console.error(`[contract] 缺文件：${f}`);
    process.exit(2);
  }
}

const overlay = fs.readFileSync(OVERLAY, 'utf8');
const src = fs.readFileSync(RENDERER, 'utf8');

/** 收集具名导出：export function/const/class + export { a, b as c } */
function namedExports(code) {
  const out = new Set();
  for (const m of code.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) {
    out.add(m[1]);
  }
  for (const m of code.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) out.add(name.trim());
    }
  }
  return out;
}

/** default 的 api 对象包含哪些键（只用于诊断展示，不参与判定） */
function apiKeys(code) {
  const i = code.indexOf('const api = {');
  if (i < 0) return new Set();
  let depth = 0;
  let end = i;
  for (let j = code.indexOf('{', i); j < code.length; j++) {
    const c = code[j];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        end = j;
        break;
      }
    }
  }
  const body = code.slice(i, end);
  const keys = new Set();
  for (const m of body.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*[:,]/gm)) keys.add(m[1]);
  return keys;
}

/** overlay 依赖的 API 面：L.xxx 与 window.DSH_L2D.xxx（排除局部变量 L 的其它用法已由前缀限定） */
function usedMembers(code) {
  const used = new Map();
  const add = (name, line) => {
    if (!used.has(name)) used.set(name, line);
  };
  const lines = code.split(/\r?\n/);
  lines.forEach((text, idx) => {
    for (const m of text.matchAll(/\bL\.([A-Za-z_$][\w$]*)/g)) add(m[1], idx + 1);
    for (const m of text.matchAll(/window\.DSH_L2D\.([A-Za-z_$][\w$]*)/g)) add(m[1], idx + 1);
  });
  return used;
}

const named = namedExports(src);
const api = apiKeys(src);
const used = usedMembers(overlay);

// 只挂 default、没具名导出的键：这批就是「运行时读不到」的高危集合
const defaultOnly = [...api].filter((k) => !named.has(k));
const missing = [...used].filter(([name]) => !named.has(name));

console.log(`[contract] renderer 具名导出 ${named.size} 个；api 键 ${api.size} 个；overlay 依赖 ${used.size} 个`);
if (defaultOnly.length) {
  console.log(`[contract] 仅存在于 default（页面读不到）：${defaultOnly.join(', ')}`);
}

if (missing.length) {
  console.error('\n[contract] FAIL —— overlay 依赖了非具名导出的成员（页面里会是 undefined）：');
  for (const [name, line] of missing) {
    console.error(`  - L.${name}  (overlay.js:${line})${api.has(name) ? '  ← 只在 default 的 api 上，必须改成具名导出' : '  ← renderer 未提供'}`);
  }
  console.error('\n修法：在 packages/renderer/src/index.ts 里 `export const <name> = ...`，api 对象用简写引用。');
  process.exit(1);
}

console.log('[contract] PASS —— overlay 依赖的成员全部是具名导出');
