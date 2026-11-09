#!/usr/bin/env node
/* =========================================================================
   motion-graph-build.mjs — Motion Graph Lab 单文件编辑器的构建期内联脚本（NE-04）。

   背景：assets/motion-graph.html 必须保持「单文件零依赖、file:// 双击可开」，
   模块化拆分因此是「源码模块 + 构建期内联回单文件」，不是运行时多文件加载。

   标记协议（标记必须独占一行）：
     <!-- BUILD:SPLIT <name> -->   区段开始（<name> = editor-src/modules/<name>.js）
     <!-- BUILD:END <name> -->    区段结束
   标记位于 <script> 内部时，`<!--` 是 Annex B 合法行注释（Script 目标），不影响运行。

   命令：
     node tools/motion-graph-build.mjs build    模板 + 模块 → 写回 assets/motion-graph.html
     node tools/motion-graph-build.mjs extract  从 assets/motion-graph.html 切出模块 + 生成模板
     node tools/motion-graph-build.mjs verify   构建结果与现文件逐字节比对（幂等/无损验收）

   文件布局：
     packages/dsh-l2d-plugin/editor-src/template.html   HTML 骨架（标记位保留、区段内容清空）
     packages/dsh-l2d-plugin/editor-src/modules/<name>.js  各区段源码（按原声明顺序由模板定位）

   无损原则：区段内容按原文字节切出/拼回，不做任何格式化或换行规整——
   extract 后立即 build 必须与切分前逐字节一致（用 verify 断言）。
   ========================================================================= */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'packages/dsh-l2d-plugin/assets/motion-graph.html');
const SRC_DIR = join(ROOT, 'packages/dsh-l2d-plugin/editor-src');
const TEMPLATE = join(SRC_DIR, 'template.html');
const MODULES = join(SRC_DIR, 'modules');

const SPLIT_RE = /^<!-- BUILD:SPLIT ([a-z0-9-]+) -->$/;
const END_RE = /^<!-- BUILD:END ([a-z0-9-]+) -->$/;

/* 扫描文本中的标记对 → [{ name, contentStart, contentEnd }]
   contentStart = SPLIT 行末换行之后；contentEnd = END 行首。
   区段内容 = 原文 slice(contentStart, contentEnd)，逐字节保真。 */
function parseRegions(text) {
  const lines = text.split('\n');
  const regions = [];
  let offset = 0;
  let open = null; // { name, contentStart }
  for (const line of lines) {
    const raw = line.replace(/\r$/, '');
    const splitM = raw.match(SPLIT_RE);
    const endM = raw.match(END_RE);
    if (splitM) {
      if (open) throw new Error(`标记嵌套错误：${open.name} 未闭合时又出现 SPLIT ${splitM[1]}（偏移 ${offset}）`);
      open = { name: splitM[1], contentStart: offset + line.length + 1 };
    } else if (endM) {
      if (!open) throw new Error(`标记配对错误：出现孤立的 END ${endM[1]}（偏移 ${offset}）`);
      if (open.name !== endM[1]) throw new Error(`标记配对错误：SPLIT ${open.name} 被 END ${endM[1]} 闭合`);
      regions.push({ name: open.name, contentStart: open.contentStart, contentEnd: offset });
      open = null;
    }
    offset += line.length + 1;
  }
  if (open) throw new Error(`标记配对错误：SPLIT ${open.name} 缺少 END`);
  const names = regions.map(r => r.name);
  if (new Set(names).size !== names.length) throw new Error('标记名重复：' + names.join(', '));
  return regions;
}

function modulePath(name) { return join(MODULES, name + '.js'); }

/* 构建：模板中每个区段，若模块文件存在则按字节内联，否则保留模板现状（安全网：不删内容） */
function assemble(templateText) {
  const regions = parseRegions(templateText);
  const known = new Set(regions.map(r => r.name));
  let out = templateText;
  // 从后往前替换，避免偏移失效
  for (let i = regions.length - 1; i >= 0; i--) {
    const r = regions[i];
    const mp = modulePath(r.name);
    if (!existsSync(mp)) continue;
    const mod = readFileSync(mp, 'utf8');
    out = out.slice(0, r.contentStart) + mod + out.slice(r.contentEnd);
  }
  if (parseRegions(out).length !== regions.length) throw new Error('内联后标记数量异常');
  return { out, regions, known };
}

function cmdBuild() {
  const hasTemplate = existsSync(TEMPLATE);
  const template = readFileSync(hasTemplate ? TEMPLATE : ASSETS, 'utf8');
  const { out, regions } = assemble(template);
  if (!hasTemplate) {
    console.log('[build] 未找到 editor-src/template.html —— 以 assets/motion-graph.html 自身为模板（内容保全模式）');
  }
  if (!regions.length) console.log('[build] 警告：模板中没有任何 BUILD:SPLIT 标记');
  writeFileSync(ASSETS, out);
  console.log(`[build] 写回 ${ASSETS}（${regions.length} 个标记区段，${Buffer.byteLength(out)} 字节）`);
}

/* 抽取：区段原文 → modules/<name>.js；模板 = 区段内容清空（标记保留） */
function cmdExtract() {
  const text = readFileSync(ASSETS, 'utf8');
  const regions = parseRegions(text);
  if (!regions.length) { console.error('[extract] 未找到任何 BUILD:SPLIT 标记，无事可做'); process.exit(1); }
  mkdirSync(MODULES, { recursive: true });
  let out = text;
  for (let i = regions.length - 1; i >= 0; i--) {
    const r = regions[i];
    const content = text.slice(r.contentStart, r.contentEnd);
    if (!content.trim()) { console.log(`[extract] 区段 ${r.name} 为空，跳过`); continue; }
    writeFileSync(modulePath(r.name), content);
    out = out.slice(0, r.contentStart) + out.slice(r.contentEnd);
    console.log(`[extract] modules/${r.name}.js（${Buffer.byteLength(content)} 字节）`);
  }
  writeFileSync(TEMPLATE, out);
  console.log(`[extract] 模板 → editor-src/template.html（${Buffer.byteLength(out)} 字节）`);
}

function cmdVerify() {
  const hasTemplate = existsSync(TEMPLATE);
  const template = readFileSync(hasTemplate ? TEMPLATE : ASSETS, 'utf8');
  const { out } = assemble(template);
  const current = readFileSync(ASSETS, 'utf8');
  if (out === current) {
    console.log('[verify] IDENTICAL —— 构建结果与现文件逐字节一致（' + Buffer.byteLength(current) + ' 字节）');
    return;
  }
  let i = 0;
  while (i < Math.min(out.length, current.length) && out[i] === current[i]) i++;
  const line = current.slice(0, i).split('\n').length;
  console.error(`[verify] DIFF —— 首个差异偏移 ${i}（第 ${line} 行）：构建 ${Buffer.byteLength(out)}B vs 现文件 ${Buffer.byteLength(current)}B`);
  process.exit(1);
}

const cmd = process.argv[2] || 'build';
if (cmd === 'build') cmdBuild();
else if (cmd === 'extract') cmdExtract();
else if (cmd === 'verify') cmdVerify();
else { console.error('用法：node tools/motion-graph-build.mjs [build|extract|verify]'); process.exit(1); }
