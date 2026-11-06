/**
 * CHAIN-15 动作链库扩充种子（任务 C；PR-CONVERGE 补齐）。
 *
 * 语义键命名规范：motion.<group>（任务书裁定）。动作/表情一律取自
 * 大肥鱼.dsl2d.model3.json 真实 Motion 组与 Expressions 白名单（不凭名称
 * 猜测——choreography.validateStep 白名单硬校验兜底），经 actions-repo
 * createActionChain 走 G0-G4 门禁入库，不做旁路写入。
 *
 * 用法：
 *   node --experimental-sqlite tools/chain-15/seed.mjs                # 干跑打印
 *   node --experimental-sqlite tools/chain-15/seed.mjs --db <path>    # 写入库（幂等 duplicate）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MODEL3 = process.env.MODEL3_PATH
  || path.join(ROOT, 'DeepSeek免费公皮', 'DeepSeek', '大肥鱼.dsl2d.model3.json');

const PROVENANCE = {
  sourceType: 'model3-json',
  sourceId: '大肥鱼.dsl2d.model3.json#FileReferences.Motions',
  analysisMethod: 'manifest-scan（S1 结构扫描，Motion 组名即官方定义，无语义推断）',
  actor: 'chain15-seed',
};

/** 15 条链（≥15 条库扩充目标）。durationMs = 声明执行时长；params.delayMs = 步间间隔。 */
export function buildChainSeeds(model3Path = MODEL3) {
  const model = JSON.parse(fs.readFileSync(model3Path, 'utf8'));
  const motionGroups = Object.keys(model.FileReferences?.Motions || {});
  const expressions = (model.FileReferences?.Expressions || []).map((e) => e.Name);
  const need = ['抚胸手打开', '抚胸手关闭', '竖手指打开', '竖手指关闭', '狗尾巴草打开', '狗尾巴草关闭'];
  for (const g of need) if (!motionGroups.includes(g)) throw new Error(`buildChainSeeds: 模型缺少 Motion 组 ${g}`);
  // Idle 不进种子：MODEL_MOTION_GROUPS 白名单不允许手动播 Idle（状态机接管）
  for (const e of ['兔牙', '脸红', '爱心眼', '流泪', '黑框眼镜', '尾巴开关', '前倾']) {
    if (!expressions.includes(e)) throw new Error(`buildChainSeeds: 模型缺少表情 ${e}`);
  }

  return [
    { semanticKey: 'motion.hand_chest_open', description: '抚胸手打开（官方 Motion 组）', emotion: 'shy', steps: [
      { index: 0, kind: 'motion', params: { name: '抚胸手打开', closeMotion: '抚胸手关闭', closeAfterMs: 4000 }, durationMs: 1200 },
    ] },
    { semanticKey: 'motion.hand_chest_close', description: '抚胸手关闭（官方 Motion 组）', emotion: 'neutral', steps: [
      { index: 0, kind: 'motion', params: { name: '抚胸手关闭' }, durationMs: 900 },
    ] },
    { semanticKey: 'motion.finger_point_open', description: '竖手指打开（官方 Motion 组）', emotion: 'curious', steps: [
      { index: 0, kind: 'motion', params: { name: '竖手指打开', closeMotion: '竖手指关闭', closeAfterMs: 5000 }, durationMs: 1200 },
    ] },
    { semanticKey: 'motion.finger_point_close', description: '竖手指关闭（官方 Motion 组）', emotion: 'neutral', steps: [
      { index: 0, kind: 'motion', params: { name: '竖手指关闭' }, durationMs: 900 },
    ] },
    { semanticKey: 'motion.dog_tail_grass_open', description: '狗尾巴草打开（官方 Motion 组）', emotion: 'playful', steps: [
      { index: 0, kind: 'motion', params: { name: '狗尾巴草打开', closeMotion: '狗尾巴草关闭', closeAfterMs: 5000 }, durationMs: 1200 },
    ] },
    { semanticKey: 'motion.dog_tail_grass_close', description: '狗尾巴草关闭（官方 Motion 组）', emotion: 'neutral', steps: [
      { index: 0, kind: 'motion', params: { name: '狗尾巴草关闭' }, durationMs: 900 },
    ] },
    { semanticKey: 'motion.idle_breathe', description: '回正组合：关闭全部手持物 + 清表情（回 Idle 由状态机接管）', emotion: 'neutral', steps: [
      { index: 0, kind: 'expression', params: { clear: true }, durationMs: 600 },
      { index: 1, kind: 'motion', params: { name: '抚胸手关闭', delayMs: 100 }, durationMs: 900 },
      { index: 2, kind: 'motion', params: { name: '竖手指关闭', delayMs: 100 }, durationMs: 900 },
    ] },
    { semanticKey: 'emotion.blush_shy', description: '脸红（官方 Expression）', emotion: 'shy', steps: [
      { index: 0, kind: 'expression', params: { name: '脸红' }, durationMs: 1500 },
    ] },
    { semanticKey: 'emotion.heart_eyes', description: '爱心眼（官方 Expression）', emotion: 'love', steps: [
      { index: 0, kind: 'expression', params: { name: '爱心眼' }, durationMs: 1500 },
    ] },
    { semanticKey: 'emotion.tears_well', description: '流泪（官方 Expression）', emotion: 'sad', steps: [
      { index: 0, kind: 'expression', params: { name: '流泪' }, durationMs: 1200 },
    ] },
    { semanticKey: 'emotion.buck_tooth_grin', description: '兔牙笑（官方 Expression）', emotion: 'happy', steps: [
      { index: 0, kind: 'expression', params: { name: '兔牙' }, durationMs: 800 },
    ] },
    { semanticKey: 'emotion.glasses_scholar', description: '黑框眼镜（官方 Expression）', emotion: 'serious', steps: [
      { index: 0, kind: 'expression', params: { name: '黑框眼镜' }, durationMs: 700 },
    ] },
    { semanticKey: 'compound.greet_point', description: '组合：视线转向 + 兔牙笑 + 竖手指打招呼', emotion: 'happy', steps: [
      { index: 0, kind: 'look', params: { x: 0.3, y: -0.1 }, durationMs: 400 },
      { index: 1, kind: 'expression', params: { name: '兔牙', delayMs: 120 }, durationMs: 600 },
      { index: 2, kind: 'motion', params: { name: '竖手指打开', closeMotion: '竖手指关闭', closeAfterMs: 4000, delayMs: 100 }, durationMs: 1200 },
    ] },
    { semanticKey: 'compound.shy_cover', description: '组合：脸红 + 抚胸手', emotion: 'shy', steps: [
      { index: 0, kind: 'expression', params: { name: '脸红' }, durationMs: 800 },
      { index: 1, kind: 'motion', params: { name: '抚胸手打开', closeMotion: '抚胸手关闭', closeAfterMs: 4000, delayMs: 150 }, durationMs: 1200 },
    ] },
    { semanticKey: 'compound.sad_tear', description: '组合：前倾 + 流泪 + 抚胸手', emotion: 'sad', steps: [
      { index: 0, kind: 'expression', params: { name: '前倾' }, durationMs: 600 },
      { index: 1, kind: 'expression', params: { name: '流泪', delayMs: 200 }, durationMs: 1000 },
      { index: 2, kind: 'motion', params: { name: '抚胸手打开', closeMotion: '抚胸手关闭', closeAfterMs: 4000, delayMs: 150 }, durationMs: 1200 },
    ] },
  ];
}

/** repo 步 → MCP 队列段步（展平 params；durationMs 留在 repo 侧供计时基准）。 */
export function chainToSegmentSteps(chain) {
  return chain.steps.map((s) => ({ kind: s.kind, ...s.params }));
}

// ---- CLI：干跑打印 / --db 写库（幂等）----
const isMain = process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (isMain) {
  const seeds = buildChainSeeds();
  console.log(`[chain15-seed] ${seeds.length} 条链：${seeds.map((s) => s.semanticKey).join(', ')}`);
  const dbIdx = process.argv.indexOf('--db');
  if (dbIdx < 0) {
    console.log('[chain15-seed] 干跑（未写库）。--db <path> 落库。');
  } else {
    const { openDb } = await import('../../packages/dsh-l2d-db/src/db.mjs');
    const { createActionsRepository } = await import('../../packages/dsh-l2d-db/src/actions-repo.mjs');
    const db = openDb({ path: process.argv[dbIdx + 1] });
    const repo = createActionsRepository(db);
    let created = 0; let dup = 0;
    for (const s of seeds) {
      const chain = { schemaVersion: '1.0', steps: s.steps };
      const r = repo.createActionChain({ semanticKey: s.semanticKey, description: s.description, emotion: s.emotion, chain, provenance: PROVENANCE, actor: PROVENANCE.actor });
      if (r.status === 'created') created++; else if (r.status === 'duplicate') dup++;
      console.log(`  ${s.semanticKey}: ${r.status} totalDurationMs=${r.totalDurationMs}`);
    }
    console.log(`[chain15-seed] created=${created} duplicate=${dup}`);
    db.close();
  }
}
