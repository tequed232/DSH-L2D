#!/usr/bin/env node
/**
 * E0 · 模型能力扫描器。
 *
 * 产出**基于模型真实文件**的 AvatarCapabilityProfile（`ModelMotionProfile`）：
 *   - 参数：cdi3.json（id + 分组）
 *   - 物理输出：physics3.json（决定 ownership：requires-own / direct）
 *   - 表情：model3 → exp3（记录每个表情写到哪些参数）
 *   - 动作：model3 → motion3（记录曲线目标参数与时长）
 *   - 眨眼/口型组：model3.Groups
 *
 * 不做的事：不猜参数范围（cdi3 不含 Min/Max，运行时可查，静态不编造）；
 * 匹配不到的通道一律 unsupported / unknown，不默认 supported。
 *
 *   node tools/capability-scan/scan.mjs                       # 用默认模型目录
 *   node tools/capability-scan/scan.mjs --model-dir <dir> --out-dir <dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveControls } from './bindings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const MODEL_DIR =
  argOf('model-dir', '') ||
  process.env.DSH_L2D_MODEL_DIR ||
  path.join(ROOT, 'DeepSeek免费公皮', 'DeepSeek');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function pickModel3(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.model3.json'));
  // 优先 dsl2d 变体；同系列里 2048 贴图档是运行时的实际选择
  const order = (f) => (/dsl2d\.2048/.test(f) ? 0 : /dsl2d\./.test(f) ? 1 : 2);
  files.sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  return files.length ? path.join(dir, files[0]) : null;
}

function contractVersion() {
  // 从源码读，避免扫描器和 core 各自写一个版本号然后漂移
  const src = fs.readFileSync(path.join(ROOT, 'packages/core/src/motion-contract.ts'), 'utf8');
  const m = src.match(/MOTION_CONTRACT_VERSION\s*=\s*(\d+)/);
  if (!m) throw new Error('读不到 MOTION_CONTRACT_VERSION');
  return Number(m[1]);
}

function readPhysicsOutputs(dir, model3) {
  const rel = model3?.FileReferences?.Physics;
  if (!rel) return [];
  const file = path.join(dir, rel);
  if (!fs.existsSync(file)) return [];
  const ph = readJson(file);
  const out = new Set();
  for (const s of ph.PhysicsSettings || []) {
    for (const o of s.Output || []) out.add(o.Destination.Id);
  }
  return [...out];
}

function readCdi(dir) {
  const file = fs.readdirSync(dir).find((f) => f.endsWith('.cdi3.json'));
  if (!file) return { file: null, params: [] };
  const cdi = readJson(path.join(dir, file));
  return {
    file,
    params: (cdi.Parameters || []).map((p) => ({ id: p.Id, group: p.GroupId, name: p.Name })),
  };
}

/** 曲线/表情引用到的参数（用于「该资源会写哪些参数」以及冲突预判） */
function motion3Targets(file) {
  if (!fs.existsSync(file)) return { params: [], durationMs: null };
  const j = readJson(file);
  const params = new Set();
  for (const curve of j.Curves || []) if (curve.Target) params.add(String(curve.Target).replace(/^Model$/, ''));
  // Cubism 3 motion3 的 Meta 有的是对象、有的是数组，两种都兜住
  const meta = Array.isArray(j.Meta) ? j.Meta.find((m) => m && typeof m === 'object') : j.Meta;
  return { params: [...params], durationMs: meta && Number.isFinite(meta.Duration) ? Math.round(meta.Duration * 1000) : null };
}

function exp3Targets(file) {
  if (!fs.existsSync(file)) return [];
  const j = readJson(file);
  return (j.Parameters || []).map((p) => p.Id).filter(Boolean);
}

function buildInventory(dir, model3Path) {
  const model3 = readJson(model3Path);
  const refs = model3.FileReferences || {};
  const { params, file: cdiFile } = readCdi(dir);
  const physicsOutputs = readPhysicsOutputs(dir, model3);

  const expressions = (refs.Expressions || []).map((e) => {
    const file = path.join(dir, e.File);
    return {
      name: e.Name,
      file: e.File,
      params: exp3Targets(file),
      exists: fs.existsSync(file),
    };
  });

  const motions = [];
  for (const [group, list] of Object.entries(refs.Motions || {})) {
    for (const m of list || []) {
      const file = path.join(dir, m.File);
      const t = motion3Targets(file);
      motions.push({
        group,
        name: path.basename(m.File, '.motion3.json'),
        file: m.File,
        exists: fs.existsSync(file),
        params: t.params,
        durationMs: t.durationMs,
        loop: !!m.Loop,
      });
    }
  }

  const groups = new Map((model3.Groups || []).map((g) => [g.Name, g.Ids || []]));

  return {
    modelId: path.basename(model3Path).replace(/\.model3\.json$/, ''),
    modelFile: path.basename(model3Path),
    cdiFile,
    params,
    physicsOutputs,
    expressions,
    motions,
    blink: groups.get('EyeBlink') || [],
    lipSync: groups.get('LipSync') || [],
  };
}

function revisionOf(inv) {
  const h = crypto.createHash('sha1');
  h.update(String(inv.modelId));
  h.update(String(inv.params.length));
  h.update(String(inv.physicsOutputs.length));
  for (const e of inv.expressions) h.update(e.name + e.params.join(','));
  for (const m of inv.motions) h.update(m.group + m.file + (m.durationMs || 0));
  return 'r' + h.digest('hex').slice(0, 12);
}

function buildAssets(inv) {
  const assets = [];
  for (const m of inv.motions) {
    if (!m.exists) continue;
    assets.push({
      id: `motion.${m.group}.${m.name}`,
      kind: 'motion',
      status: 'supported',
      ...(m.durationMs ? { durationMs: m.durationMs } : {}),
      resources: [m.file],
      interruptible: true,
      loopable: m.loop,
    });
  }
  for (const e of inv.expressions) {
    if (!e.exists) continue;
    assets.push({
      id: `expression.${e.name}`,
      kind: 'expression',
      status: 'supported',
      resources: [e.file],
      interruptible: true,
      loopable: false,
    });
  }
  return assets;
}

function buildMarkdown(inv, profile) {
  const byStatus = profile.controls.reduce((acc, c) => ({ ...acc, [c.status]: (acc[c.status] || 0) + 1 }), {});
  const conflicts = [];
  for (const c of profile.controls) {
    const ids = String(c.sourceId || '').split('+').filter(Boolean);
    const phys = ids.filter((id) => inv.physicsOutputs.includes(id));
    if (phys.length) conflicts.push({ channel: c.id, params: phys });
  }

  const rows = profile.controls
    .map((c) => {
      const own = c.ownership === 'requires-own' ? '需 own' : c.ownership === 'direct' ? '直写' : '—';
      return `| \`${c.id}\` | ${c.status} | ${c.sourceId || '—'} | ${own} | ${c.confidence} | ${c.reason || ''} |`;
    })
    .join('\n');

  const unsupported = profile.controls.filter((c) => c.status === 'unsupported' || c.status === 'unknown');

  return `# 模型能力画像 · ${inv.modelId}

> 扫描器：\`tools/capability-scan/scan.mjs\`（数据全部来自模型文件，不靠命名推断）
> 输入：\`${inv.modelFile}\`、\`${inv.cdiFile || '无 cdi3'}\`
> 契约版本：v${profile.contractVersion} · profileRevision：\`${profile.profileRevision}\`

## 摘要

- 参数 ${inv.params.length} 个，其中物理输出 ${inv.physicsOutputs.length} 个（物理持有，直写需 own）
- 表情 ${inv.expressions.length} 个、动作文件 ${inv.motions.length} 个（动作组 ${new Set(inv.motions.map((m) => m.group)).size} 个）
- 语义通道 ${profile.controls.length} 个：${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(' · ')}
- 眨眼组 ${inv.blink.length} 个参数；口型组 ${inv.lipSync.length} 个参数（口型是红线，任何通道不得写）

## 语义通道

| 通道 | 状态 | 真实参数 | 写入方式 | 置信度 | 说明 |
|---|---|---|---|---|---|
${rows}

## 不支持 / 未知（必须降级，不得硬凑）

${unsupported.length ? unsupported.map((c) => `- \`${c.id}\`（${c.status}）：${c.reason || '无说明'}`).join('\n') : '（无）'}

## 物理冲突面

这些通道落到物理输出上，写入前必须 \`own:true\`，否则会被 physics 覆盖：

${conflicts.length ? conflicts.map((c) => `- \`${c.channel}\` → ${c.params.join(', ')}`).join('\n') : '（无）'}

## 资产

- 动作：${profile.assets.filter((a) => a.kind === 'motion').length} 个（含循环 ${profile.assets.filter((a) => a.loopable).length} 个）
- 表情：${profile.assets.filter((a) => a.kind === 'expression').length} 个

## 已知边界

- **腿部**：本模型只有 ${inv.params.filter((p) => /leg|knee|ankle|foot/i.test(p.id)).length} 个腿部相关参数，且是物理输出，无法表达「并拢/膝内收」这类语义——行为模板必须显式降级。
- **手指**：${inv.params.filter((p) => /finger/i.test(p.id)).length} 个手指参数，抓握类动作只能靠预制 Motion。
- **参数范围**：cdi3 不含 Min/Max/Default，静态扫描不编造；运行时可从 Cubism 查询（\`getParameterMinimumValue\`）。
`;
}

function main() {
  if (!fs.existsSync(MODEL_DIR)) {
    console.error(`模型目录不存在：${MODEL_DIR}`);
    process.exit(2);
  }
  const model3Path = pickModel3(MODEL_DIR);
  if (!model3Path) {
    console.error('目录里没有 .model3.json');
    process.exit(2);
  }

  const inv = buildInventory(MODEL_DIR, model3Path);
  const { controls, unresolved } = resolveControls(inv);

  const profile = {
    contractVersion: contractVersion(),
    modelId: inv.modelId,
    adapterId: 'cubism',
    profileRevision: revisionOf(inv),
    controls,
    assets: buildAssets(inv),
    metadata: {
      scannedAt: new Date().toISOString(),
      modelFile: inv.modelFile,
      cdiFile: inv.cdiFile || '',
      paramCount: inv.params.length,
      physicsOutputCount: inv.physicsOutputs.length,
      motionCount: inv.motions.length,
      expressionCount: inv.expressions.length,
    },
  };

  const outDir = argOf('out-dir', HERE);
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `profile.${inv.modelId}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(profile, null, 2) + '\n');

  const docPath = path.join(ROOT, 'docs', `Capability-Profile-${inv.modelId}.md`);
  fs.writeFileSync(docPath, buildMarkdown(inv, profile));

  const byStatus = controls.reduce((acc, c) => ({ ...acc, [c.status]: (acc[c.status] || 0) + 1 }), {});
  console.log(`[scan] model=${inv.modelId} 参数=${inv.params.length} 物理输出=${inv.physicsOutputs.length}`);
  console.log(`[scan] 通道 ${controls.length}：${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (unresolved.length) console.log(`[scan] 未绑定通道：${unresolved.join(', ')}`);
  console.log(`[scan] 写出 ${path.relative(ROOT, jsonPath)} 与 ${path.relative(ROOT, docPath)}`);
}

main();
