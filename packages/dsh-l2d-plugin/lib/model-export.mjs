/**
 * model-export —— 模型 zip 导出（设置页「快捷导出」的后端实现，传输无关）。
 *
 * 与导入（lib/model-import.mjs）对称：导出物必须能被 POST /dsh-l2d/models/import
 * 原样回导——zip 内条目按「相对模型根的正斜杠路径」存放，模型根文件在 zip 根。
 *
 * 模型定位（modelId → 目录）三级解析，覆盖仓库里实际存在的三种布局：
 *   1. `<MODEL_DIR>/<modelId>/`                      —— 每模型一目录（推荐布局）；
 *   2. `<MODEL_DIR>/<modelId>.model3.json` 直接在顶层 —— 扁平布局（大肥鱼）；
 *   3. 顶层找不到时在 MODEL_DIR 下递归找 `<modelId>.model3.json`
 *      （workshop/<uid>/<包名>/ 这类嵌套布局，深度上限 6，跳过 . 开头与 __pycache__）；
 *      唯一命中 → 用其所在目录；多个命中 → ambiguous-model（不猜）。
 *
 * 收集口径：
 *   - 目录布局：递归收集该目录下全部文件（跳过 . 开头条目与 __pycache__）——
 *     整包导出，回导后目录内容不变；
 *   - 扁平布局：只收集「属于该模型」的文件（model3 自身 + FileReferences 引用到的
 *     moc3/physics3/textures/exp3/motion3/pose/userdata + 同目录 cdi3）——扁平目录里
 *     混着别的模型的资源，整目录导出会把别人的贴图打进来。
 *
 * 上限与导入侧同口径（4000 条目 / 512MB 解压总量），超限 413 中文提示。
 * 内存：上限内整体构造 Buffer 同步返回（512MB 上限内可接受；需要更大再改流式）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { isSafeModelId } from './nodegraph-schema.mjs';
import { makeZip } from './zip-writer.mjs';

export const MODEL_EXPORT_LIMITS = Object.freeze({
  maxEntries: 4000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxDepth: 6,
});

const SKIP_DIR_NAMES = new Set(['__pycache__']);

function isSkippedEntryName(name) {
  return name.startsWith('.') || SKIP_DIR_NAMES.has(name);
}

/** 目录里是否有 .model3.json（任意变体）。 */
function listModel3Files(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.model3.json')).sort();
  } catch {
    return [];
  }
}

/**
 * 递归找 `<modelId>.model3.json`（深度上限内），返回全部命中路径。
 * 跳过 . 开头与 __pycache__ 目录，读不了的目录静默跳过。
 */
function findModel3Paths(root, modelId) {
  const target = (modelId + '.model3.json').toLowerCase();
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > MODEL_EXPORT_LIMITS.maxDepth || hits.length > 8) return;
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.isDirectory()) {
        if (isSkippedEntryName(item.name)) continue;
        walk(path.join(dir, item.name), depth + 1);
      } else if (item.isFile() && item.name.toLowerCase() === target) {
        hits.push(path.join(dir, item.name));
      }
    }
  };
  walk(root, 0);
  return hits.sort();
}

/** modelId → {mode:'dir'|'flat', dir} | {error} */
function resolveModelSource(modelDir, modelId) {
  // 1) 每模型一目录：<MODEL_DIR>/<modelId>/（先看同名 model3，再退一步接受目录内任意单模型）
  const subDir = path.join(modelDir, modelId);
  try {
    if (fs.statSync(subDir).isDirectory()) {
      if (fs.existsSync(path.join(subDir, modelId + '.model3.json'))) {
        return { mode: 'dir', dir: subDir };
      }
      const inner = findModel3Paths(subDir, modelId);
      if (inner.length === 1) return { mode: 'dir', dir: path.dirname(inner[0]) };
      if (inner.length > 1) {
        return {
          error: {
            status: 409,
            code: 'ambiguous-model',
            message: '目录 ' + modelId + ' 内有多个 ' + modelId + '.model3.json，无法确定导出哪一个',
          },
        };
      }
    }
  } catch {
    /* 目录不存在：继续下一步 */
  }

  // 2) 扁平布局：<MODEL_DIR>/<modelId>.model3.json
  if (fs.existsSync(path.join(modelDir, modelId + '.model3.json'))) {
    return { mode: 'flat', dir: modelDir };
  }

  // 3) 嵌套布局递归找
  const hits = findModel3Paths(modelDir, modelId);
  if (!hits.length) {
    return { error: { status: 404, code: 'model-not-found', message: '模型不存在或未找到 ' + modelId + '.model3.json' } };
  }
  if (hits.length > 1) {
    return {
      error: {
        status: 409,
        code: 'ambiguous-model',
        message: '找到 ' + hits.length + ' 个 ' + modelId + '.model3.json，无法确定导出哪一个：' +
          hits.slice(0, 4).map((p) => path.relative(modelDir, p)).join(', '),
      },
    };
  }
  const dir = path.dirname(hits[0]);
  return { mode: dir === modelDir ? 'flat' : 'dir', dir };
}

/** 递归收集目录下全部文件（相对路径正斜杠归一；超限即返回 error）。 */
function collectDirFiles(dir, limits) {
  const files = [];
  let total = 0;
  let overflow = null;
  const walk = (current, prefix) => {
    if (overflow) return;
    let items;
    try {
      items = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (overflow) return;
      if (isSkippedEntryName(item.name)) continue;
      const full = path.join(current, item.name);
      const rel = prefix ? prefix + '/' + item.name : item.name;
      if (item.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!item.isFile()) continue;
      const size = fs.statSync(full).size;
      if (files.length + 1 > limits.maxEntries) {
        overflow = { status: 413, code: 'export-too-large', message: '模型文件条目超过上限（' + limits.maxEntries + '），无法导出' };
        return;
      }
      if (total + size > limits.maxTotalBytes) {
        overflow = {
          status: 413,
          code: 'export-too-large',
          message: '模型文件总量超过上限（' + Math.round(limits.maxTotalBytes / 1024 / 1024) + 'MB），无法导出',
        };
        return;
      }
      total += size;
      files.push({ rel, full, size });
    }
  };
  walk(dir, '');
  return overflow ? { error: overflow } : { files, total };
}

/** 扁平布局：只收集属于该模型的文件（model3 + 引用资源 + 同目录 cdi3）。 */
function collectFlatModelFiles(modelDir, modelId, limits) {
  const model3Path = path.join(modelDir, modelId + '.model3.json');
  let model3 = null;
  try {
    model3 = JSON.parse(fs.readFileSync(model3Path, 'utf8'));
  } catch {
    model3 = null; // 坏 JSON：至少把 model3 本体导出，其余按目录事实尽力
  }
  const refs = (model3 && model3.FileReferences) || {};
  const candidates = [model3Path];
  const pushRel = (rel) => {
    if (typeof rel !== 'string' || !rel) return;
    candidates.push(path.resolve(modelDir, rel));
  };
  pushRel(refs.Moc);
  pushRel(refs.Physics);
  pushRel(refs.Pose);
  pushRel(refs.UserData);
  for (const tex of Array.isArray(refs.Textures) ? refs.Textures : []) pushRel(tex);
  for (const exp of Array.isArray(refs.Expressions) ? refs.Expressions : []) pushRel(exp && exp.File);
  if (refs.Motions && typeof refs.Motions === 'object') {
    for (const list of Object.values(refs.Motions)) {
      for (const m of Array.isArray(list) ? list : []) pushRel(m && m.File);
    }
  }
  // cdi3 不被 model3 引用，但属模型源事实（参数/Part 语义名），一并带上。
  const cdi3 = path.join(modelDir, modelId + '.cdi3.json');
  if (fs.existsSync(cdi3)) candidates.push(cdi3);

  const seen = new Set();
  const files = [];
  let total = 0;
  for (const full of candidates) {
    if (seen.has(full)) continue;
    seen.add(full);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue; // 引用缺失：跳过（不因为一个坏引用拒绝整包导出）
    }
    if (!stat.isFile()) continue;
    if (files.length + 1 > limits.maxEntries) {
      return { error: { status: 413, code: 'export-too-large', message: '模型文件条目超过上限（' + limits.maxEntries + '），无法导出' } };
    }
    if (total + stat.size > limits.maxTotalBytes) {
      return {
        error: {
          status: 413,
          code: 'export-too-large',
          message: '模型文件总量超过上限（' + Math.round(limits.maxTotalBytes / 1024 / 1024) + 'MB），无法导出',
        },
      };
    }
    const rel = path.relative(modelDir, full).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..')) continue; // 引用跑出模型根：不导出（防越界）
    total += stat.size;
    files.push({ rel, full, size: stat.size });
  }
  return { files, total };
}

/**
 * 构造模型导出 zip。
 *
 * @param {{modelDir: string, modelId: string,
 *          limits?: {maxEntries?: number, maxTotalBytes?: number, maxDepth?: number}}} options
 * @returns {{ok: true, buffer: Buffer, entryCount: number, bytes: number,
 *            mode: 'dir'|'flat', sourceDir: string} |
 *           {ok: false, error: {status: number, code: string, message: string}}}
 */
export function buildModelExportZip(options = {}) {
  const modelDir = options.modelDir;
  const rawModelId = typeof options.modelId === 'string' ? options.modelId.trim() : '';
  // modelId 语义与导入管线同源：不带 .model3.json 后缀的模型名（lib/model-import.mjs
  // 的 modelId = 文件名去后缀）。这里额外容错：前端若把 status.json 的原始文件名
  // （带 .model3.json）直接传进来，剥掉后缀再解析，两种形态都能导出。
  const modelId = rawModelId.replace(/\.model3\.json$/i, '');
  const limits = {
    maxEntries: options.limits?.maxEntries || MODEL_EXPORT_LIMITS.maxEntries,
    maxTotalBytes: options.limits?.maxTotalBytes || MODEL_EXPORT_LIMITS.maxTotalBytes,
    maxDepth: options.limits?.maxDepth || MODEL_EXPORT_LIMITS.maxDepth,
  };
  if (!modelDir || typeof modelDir !== 'string') {
    throw new Error('buildModelExportZip: modelDir 必填');
  }
  if (!modelId || !isSafeModelId(modelId)) {
    return {
      ok: false,
      error: { status: 400, code: 'invalid-model-id', message: 'modelId 非法（拦 .. 与路径分隔符）：' + rawModelId.slice(0, 40) },
    };
  }
  const resolved = resolveModelSource(modelDir, modelId);
  if (resolved.error) return { ok: false, error: resolved.error };

  let collected;
  try {
    collected = resolved.mode === 'dir'
      ? collectDirFiles(resolved.dir, limits)
      : collectFlatModelFiles(resolved.dir, modelId, limits);
  } catch (err) {
    return { ok: false, error: { status: 500, code: 'export-failed', message: '读取模型文件失败：' + String((err && err.message) || err) } };
  }
  if (collected.error) return { ok: false, error: collected.error };
  if (!collected.files.length) {
    return { ok: false, error: { status: 404, code: 'model-not-found', message: '模型目录为空或没有可导出文件：' + modelId } };
  }

  const entries = [];
  let bytes = 0;
  for (const file of collected.files) {
    let data;
    try {
      data = fs.readFileSync(file.full);
    } catch (err) {
      return { ok: false, error: { status: 500, code: 'export-failed', message: '读取文件失败：' + file.rel + '（' + String((err && err.message) || err) + '）' } };
    }
    bytes += data.length;
    entries.push({ name: file.rel, data, method: 'deflate' });
  }
  return {
    ok: true,
    buffer: makeZip(entries),
    entryCount: entries.length,
    bytes,
    mode: resolved.mode,
    sourceDir: path.relative(modelDir, resolved.dir).replace(/\\/g, '/') || '.',
    // 归一化后的模型名（去 .model3.json 后缀）：路由用它生成下载文件名。
    modelId,
  };
}
