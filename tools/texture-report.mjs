#!/usr/bin/env node
/**
 * P2 · 纹理清单与 GPU 预算报告生成器。
 *
 * 扫描模型目录下所有 model3.json 变体（原版 / dsl2d-2048 …），
 * 读取 FileReferences.Textures 引用的 PNG（头部解析真实宽高 + 磁盘体积），
 * 用 packages/core/src/texture-budget.ts 的纯函数计算：
 *   - 每纹理估算显存（宽×高×像素格式×mipmap 1.33）
 *   - 原始合计 / 各档位（2048/1024/512）合计
 *   - 自动档位建议与警告（≤32MB → 档位可行，超限 → 模型超出低配预算）
 *
 * 本工具只产报告，不改加载行为（运行时降采样是后续批次）。
 *
 *   node --experimental-strip-types tools/texture-report.mjs
 *   node --experimental-strip-types tools/texture-report.mjs --model-dir <dir> --out <file>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeTextureBudget, TEXTURE_TIERS } from '../packages/core/src/texture-budget.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const MODEL_DIR =
  argOf('model-dir', '') ||
  process.env.DSH_L2D_MODEL_DIR ||
  path.join(ROOT, 'DeepSeek免费公皮', 'DeepSeek');
const OUT_FILE = argOf('out', path.join(HERE, 'texture-report.json'));

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** PNG 头解析真实宽高（IHDR：签名 8B + 长度 4B + "IHDR" 4B 后是宽高各 4B BE） */
function pngSize(file) {
  const b = Buffer.alloc(24);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, b, 0, 24, 0);
  } finally {
    fs.closeSync(fd);
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!b.subarray(0, 8).equals(sig)) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function pickModel3Files(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.model3.json'));
  // dsl2d.2048 是运行时实际选择；原版 model3 留作对照
  const order = (f) => (/dsl2d\.2048/.test(f) ? 0 : /dsl2d\./.test(f) ? 1 : 2);
  return files.sort((a, b) => order(a) - order(b) || a.localeCompare(b));
}

/** 从 model3.json 构建纹理清单（含 cdi3 显示信息有无的标记） */
function buildInventory(dir, model3Path) {
  const model3 = readJson(model3Path);
  const textures = model3?.FileReferences?.Textures || [];
  const occurrences = new Map();
  for (const t of textures) occurrences.set(t, (occurrences.get(t) || 0) + 1);

  const items = [];
  const problems = [];
  for (const rel of new Set(textures)) {
    const file = path.join(dir, rel);
    if (!fs.existsSync(file)) {
      problems.push(`纹理缺失：${rel}`);
      continue;
    }
    const size = pngSize(file);
    if (!size) {
      problems.push(`PNG 头解析失败：${rel}`);
      continue;
    }
    items.push({
      id: rel,
      width: size.width,
      height: size.height,
      pixelFormat: 'rgba8', // 渲染路径固定 texImage2D RGBA/UNSIGNED_BYTE
      mipmap: true, // lapptexturemanager 上传后固定 generateMipmap
      refCount: occurrences.get(rel) || 1,
      fileBytes: fs.statSync(file).size,
    });
  }
  return {
    modelId: path.basename(model3Path).replace(/\.model3\.json$/, ''),
    modelFile: path.basename(model3Path),
    textureCount: textures.length,
    uniqueCount: items.length,
    items,
    problems,
  };
}

/** 固定 GPU 开销（不随纹理档位变化）：遮蔽缓冲 2×2048² RGBA（lappmodel.ts MASK_BUFFER_COUNT=2） */
const MASK_BUFFER_BYTES = 2 * 2048 * 2048 * 4;

function reportForVariant(dir, model3Path) {
  const inv = buildInventory(dir, model3Path);
  const budget = computeTextureBudget(inv.items);

  // 各档位估算阶梯（报告用；决策以 budget 为准）
  const ladder = {};
  for (const tier of TEXTURE_TIERS) {
    const r = computeTextureBudget(inv.items, { tier });
    ladder[String(tier)] = { totalBytes: r.totalBytes, feasible: r.tierFeasible };
  }

  return {
    ...inv,
    originalBytes: budget.originalBytes,
    fileBytesTotal: inv.items.reduce((s, t) => s + (t.fileBytes || 0), 0),
    tierLadder: ladder,
    recommendation: {
      tier: budget.tier,
      tierFeasible: budget.tierFeasible,
      totalBytes: budget.totalBytes,
      budgetBytes: budget.budgetBytes,
      warnings: budget.warnings,
    },
    perTexture: budget.perTexture.map((t) => ({
      id: t.id,
      original: `${t.width}x${t.height}`,
      tier: `${t.tierWidth}x${t.tierHeight}`,
      bytes: t.bytes,
      fileBytes: t.fileBytes,
      refCount: t.refCount,
    })),
  };
}

// ---------------------------------------------------------------- 资源释放审计结论
// 审计对象：packages/renderer/src/index.ts mount()/destroy() 与 SDK 装配层。
// 只记录结论；仅当前调用路径存在真实泄漏时才改代码（本次未改运行时代码）。
const AUDIT = {
  auditedAt: new Date().toISOString(),
  scope: [
    'packages/renderer/src/index.ts (mount/destroy)',
    'packages/renderer/src/app/lappsubdelegate.ts',
    'packages/renderer/src/app/lapptexturemanager.ts',
    'packages/renderer/src/app/lapplive2dmanager.ts',
    'packages/renderer/src/app/lappmodel.ts',
    'packages/renderer/src/app/lappglmanager.ts',
    'packages/renderer/src/fw/rendering/cubismoffscreenmanager.ts',
  ],
  conclusions: [
    {
      path: 'mount() → destroy()（当前唯一切换路径）',
      verdict: 'ok',
      detail:
        'mount 首行 await destroy()：取消 rAF 与兜底定时器、model.release()（CubismUserModel.release 释放 motion/expression/moc/model/physics/pose/breath + deleteRenderer→clippingManager.release）、sub.release()（live2dManager/view/textureManager.release→deleteTexture×N、ResizeObserver disconnect）。纹理与模型侧资源按调用路径闭环。',
    },
    {
      path: 'LAppLive2DManager.loadModelUrl / changeScene',
      verdict: 'risk',
      detail:
        '两者只 this._models.length = 0，不调用旧 model.release()。当前唯一调用方 index.ts mount() 先 destroy() 规避了泄漏；若未来绕过 mount 直接切模型，会泄漏旧模型的全部 GPU 资源。建议后续把 release 下沉到 loadModelUrl 内部（本次不改）。',
    },
    {
      path: 'CubismWebGLOffscreenManager（遮蔽 RenderTexture 单例池）',
      verdict: 'risk',
      detail:
        '单例 _contextManagers 按 gl 上下文缓存 framebuffer+colorBuffer；存在 removeContext(gl) 但全仓库无人调用，LAppGlManager.release() 是空实现。每次 mount 新建 canvas/GL 上下文时，旧上下文的遮蔽 RenderTexture 会滞留在单例里。若宿主复用同一 canvas 则同上下文复用、无泄漏；换 canvas 挂载则每次切换累积 2×画布尺寸的显存。建议 destroy() 时调用 removeContext(旧gl)（本次不改）。',
    },
    {
      path: '监听器与 Blob URL',
      verdict: 'ok',
      detail:
        'window 级监听器（visibility/blur/focus/pointer）由 __DSH_L2D_GUARD__ 幂等守卫，按设计常驻不随模型销毁；ResizeObserver 在 sub.release() 断开；纹理走 Image.src 直链加载，无 createObjectURL，无需 revoke。本次新增的 webglcontextlost/restored 监听由 webgl-recovery handle 在 destroy() 时 detach。',
    },
  ],
  maskBufferNote:
    `遮蔽 RenderTexture 固定开销 ${MASK_BUFFER_BYTES} 字节（2×2048² RGBA，MASK_BUFFER_COUNT=2），不随纹理档位变化，在 32MB 纹理预算之外。`,
};

function main() {
  if (!fs.existsSync(MODEL_DIR)) {
    console.error(`模型目录不存在：${MODEL_DIR}`);
    process.exit(2);
  }
  const files = pickModel3Files(MODEL_DIR);
  if (!files.length) {
    console.error('目录里没有 .model3.json');
    process.exit(2);
  }

  const variants = files.map((f) => {
    const report = reportForVariant(MODEL_DIR, path.join(MODEL_DIR, f));
    console.log(
      `[report] ${report.modelId}: 纹理 ${report.textureCount} 张（去重 ${report.uniqueCount}）` +
        ` 原始≈${(report.originalBytes / 1024 / 1024).toFixed(1)}MB` +
        ` → 建议 ${report.recommendation.tier} 档 ≈${(report.recommendation.totalBytes / 1024 / 1024).toFixed(1)}MB` +
        `（${report.recommendation.tierFeasible ? '可行' : '超出低配预算'}）`,
    );
    for (const p of report.problems) console.warn(`[report]   ${p}`);
    return report;
  });

  const report = {
    generatedAt: new Date().toISOString(),
    modelDir: path.relative(ROOT, MODEL_DIR) || MODEL_DIR,
    tool: 'tools/texture-report.mjs',
    estimator: 'packages/core/src/texture-budget.ts',
    formula: '宽×高×像素格式字节数×(mipmap?1.33:1)；同路径重复引用 GPU 只驻留一份，refCount 不乘',
    budgetBytes: 32 * 1024 * 1024,
    maskBufferNote: AUDIT.maskBufferNote,
    variants,
    audit: AUDIT,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2) + '\n');
  console.log(`[report] 写出 ${path.relative(ROOT, OUT_FILE)}`);
}

main();
