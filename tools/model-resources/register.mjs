#!/usr/bin/env node
/**
 * [#28] 模型资源登记补丁（方案 A）：把 model3.json 同目录里未被 FileReferences
 * 引用的 *.exp3.json / *.motion3.json 写回 model3.json。
 *
 * 背景：VTS 导出的模型（如 miku / 丰川祥子）FileReferences 不含 Expressions/Motions，
 * 但目录里有真实资源。渲染端只认 FileReferences（lappmodel.ts 无目录扫描），校验
 * 白名单的目录扫描回退只能放行到闸门、渲染端仍加载不到。本补丁做数据修复：
 *   - Expressions 追加 { Name, File }（Name = 文件名去 .exp3.json）
 *   - Motions 追加组键（组名 = 文件名去 .motion3.json 再去 _NN/-NN 序号后缀），
 *     组内条目 { File }
 * 命名规则与运行时回退（host-guard.scanExpressionFiles / scanMotionGroups）共用，
 * 绝不分叉。已存在的 Name / File 不重复追加；脚本幂等（重跑 added=0）。
 *
 * 用法：
 *   node tools/model-resources/register.mjs                    # 默认目录（env 可覆盖）
 *   node tools/model-resources/register.mjs --model-dir <dir>
 *   node tools/model-resources/register.mjs --dry-run          # 只打印不写
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanExpressionFiles, scanMotionGroups, discoverModelFiles } from '../../packages/dsh-l2d-plugin/lib/host-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const DRY_RUN = args.includes('--dry-run');

const MODEL_DIR = path.resolve(
  argOf('model-dir', '') ||
    process.env.DSH_L2D_MODEL_DIR ||
    path.join(ROOT, 'DeepSeek免费公皮', 'DeepSeek'),
);

/** 原子写：先写同目录临时文件再 rename；保留原文件的缩进风格与尾换行。 */
function writeJsonAtomic(file, data, rawOriginal) {
  const indent = /^\s*\t/m.test(rawOriginal) ? '\t' : '  ';
  const trailing = rawOriginal.endsWith('\n') ? '\n' : '';
  const tmp = file + '.tmp-register-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, indent) + trailing, 'utf8');
  fs.renameSync(tmp, file);
}

let totalExpr = 0;
let totalMotionFiles = 0;
const modelFiles = discoverModelFiles(MODEL_DIR);
if (!modelFiles.length) {
  console.error('[register] 目录里没有 .model3.json：' + MODEL_DIR);
  process.exit(1);
}

for (const modelFile of modelFiles) {
  const file = path.join(MODEL_DIR, modelFile);
  let raw;
  let json;
  try {
    raw = fs.readFileSync(file, 'utf8');
    json = JSON.parse(raw);
  } catch (err) {
    console.warn('[register] 跳过不可解析的 ' + modelFile + '：' + String((err && err.message) || err));
    continue;
  }
  if (!json.FileReferences || typeof json.FileReferences !== 'object') {
    json.FileReferences = {};
  }
  const refs = json.FileReferences;
  if (!Array.isArray(refs.Expressions)) refs.Expressions = [];
  if (!refs.Motions || typeof refs.Motions !== 'object' || Array.isArray(refs.Motions)) refs.Motions = {};

  // 表情：Name = 文件名去扩展名；已有同名/同 File 不重复。
  const expFiles = scanExpressionFiles(MODEL_DIR, fs);
  const knownExpNames = new Set(refs.Expressions.map((e) => e && e.Name).filter(Boolean));
  const knownExpFiles = new Set(refs.Expressions.map((e) => e && e.File).filter(Boolean));
  const addedExpr = [];
  for (const name of expFiles) {
    const fileName = name + '.exp3.json';
    if (knownExpNames.has(name) || knownExpFiles.has(fileName)) continue;
    refs.Expressions.push({ Name: name, File: fileName });
    addedExpr.push(name);
  }

  // 动作：组名 = 去扩展名 + 去序号后缀；已有组追加缺文件，缺组整组新建。
  const motionFiles = fs
    .readdirSync(MODEL_DIR)
    .filter((n) => typeof n === 'string' && n.endsWith('.motion3.json'))
    .sort();
  const addedMotion = [];
  for ( const fileName of motionFiles) {
    const base = fileName.slice(0, -'.motion3.json'.length);
    const group = base.replace(/[_-]\d+$/, '') || base;
    if (!Array.isArray(refs.Motions[group])) refs.Motions[group] = [];
    const knownFiles = new Set(refs.Motions[group].map((m) => m && m.File).filter(Boolean));
    if (knownFiles.has(fileName)) continue;
    refs.Motions[group].push({ File: fileName });
    addedMotion.push(group + ':' + fileName);
  }

  if (addedExpr.length || addedMotion.length) {
    if (!DRY_RUN) writeJsonAtomic(file, json, raw);
    console.log(
      '[register] ' + modelFile + '：表情 +' + addedExpr.length + '（' + addedExpr.join(', ') + '）' +
        '，动作 +' + addedMotion.length + '（' + addedMotion.join(', ') + '）' +
        (DRY_RUN ? '（dry-run 未写盘）' : '（已原子写回）'),
    );
  } else {
    console.log('[register] ' + modelFile + '：无缺登记（幂等）');
  }
  totalExpr += addedExpr.length;
  totalMotionFiles += addedMotion.length;
}

console.log('[register] 完成：目录 ' + MODEL_DIR + '，表情 +' + totalExpr + '，动作条目 +' + totalMotionFiles + (DRY_RUN ? '（dry-run）' : ''));
